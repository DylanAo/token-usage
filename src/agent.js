import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverSourceSessionFiles,
  discoverUsageSources,
  loadCodexTitleIndex,
  streamUsageFileEvents,
} from "./usage-core.js";

export const AGENT_VERSION = "0.1.0";
const DEFAULT_INTERVAL_MS = 15000;
const MAX_EVENTS_PER_REQUEST = 200;
const MAX_SEEN_EVENTS = 100000;

function nonEmpty(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

export function sessionStatus(lastActivityMs, nowMs = Date.now()) {
  const age = Math.max(0, nowMs - Number(lastActivityMs || 0));
  if (age <= 90000) {
    return "active";
  }
  if (age <= 300000) {
    return "waiting";
  }
  return "completed";
}

function eventKey(machineId, provider, sessionId, event, index) {
  const usage = event.usage || {};
  return [
    machineId,
    provider,
    sessionId,
    event.timestampMs,
    index,
    usage.total || 0,
    usage.input || 0,
    usage.cached || 0,
    usage.output || 0,
    usage.reasoning || 0,
  ].join(":");
}

function remoteSessionId(machineId, provider, sessionId) {
  return `${machineId}:${provider}:${sessionId}`;
}

export function normalizeAgentOptions(options = {}) {
  const server = nonEmpty(options.server || process.env.TOKEN_USAGE_SERVER, "").replace(/\/$/, "");
  const token = nonEmpty(options.token || process.env.TOKEN_USAGE_TOKEN, "");
  if (!server) {
    throw new Error("Agent server is required. Use --server or TOKEN_USAGE_SERVER.");
  }
  if (!token) {
    throw new Error("Agent token is required. Use --token or TOKEN_USAGE_TOKEN.");
  }
  const machineId = nonEmpty(options.machineId || process.env.TOKEN_USAGE_MACHINE_ID, os.hostname());
  const normalizedMachineId = machineId.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 100) || "machine";
  return {
    server,
    token,
    machineId: normalizedMachineId,
    label: nonEmpty(options.label || process.env.TOKEN_USAGE_MACHINE_LABEL, machineId),
    homeDir: options.homeDir || process.env.TOKEN_USAGE_HOME_DIR || os.homedir(),
    intervalMs: Math.max(5000, Number(options.intervalMs || process.env.TOKEN_USAGE_AGENT_INTERVAL || DEFAULT_INTERVAL_MS)),
    once: Boolean(options.once),
  };
}

export async function collectAgentPayload(options, { seen = new Set(), nowMs = Date.now() } = {}) {
  const sources = await discoverUsageSources({ homeDir: options.homeDir });
  const sessions = new Map();
  const events = [];

  for (const source of sources) {
    if (source.provider === "codex") {
      source.codexTitles = await loadCodexTitleIndex(source.path);
    }
    let files = [];
    try {
      files = await discoverSourceSessionFiles(source);
    } catch {
      continue;
    }
    for (const filePath of files) {
      let info;
      try {
        info = await stat(filePath);
      } catch {
        continue;
      }
      let eventIndex = 0;
      let sessionInfo = null;
      await streamUsageFileEvents(filePath, source, (event) => {
        eventIndex += 1;
        const sessionId = remoteSessionId(options.machineId, source.provider, event.sessionId);
        const existing = sessions.get(sessionId) || {
          sessionId,
          provider: source.provider,
          title: event.sessionTitle || "",
          project: event.project || source.label,
          model: event.model || "",
          firstAtMs: event.timestampMs,
          lastEventMs: event.timestampMs,
          lastActivityMs: info.mtimeMs,
          homeId: source.id,
          homeLabel: source.label,
        };
        existing.title ||= event.sessionTitle || "";
        existing.project ||= event.project || source.label;
        existing.model ||= event.model || "";
        existing.firstAtMs = Math.min(existing.firstAtMs, event.timestampMs);
        existing.lastEventMs = Math.max(existing.lastEventMs, event.timestampMs);
        existing.lastActivityMs = Math.max(existing.lastActivityMs, info.mtimeMs, event.timestampMs);
        sessions.set(sessionId, existing);
        sessionInfo = existing;

        const key = eventKey(options.machineId, source.provider, event.sessionId, event, eventIndex);
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        if (seen.size > MAX_SEEN_EVENTS) {
          seen.delete(seen.values().next().value);
        }
        events.push({
          eventKey: key,
          provider: source.provider,
          sessionId,
          sessionTitle: event.sessionTitle || "",
          homeId: source.id,
          homeLabel: source.label,
          channel: event.channel || "",
          project: event.project || source.label,
          model: event.model || "",
          timestampMs: event.timestampMs,
          usage: event.usage,
        });
      });
      if (sessionInfo && filePath.includes(`${path.sep}archived_sessions${path.sep}`)) {
        sessionInfo.lastActivityMs = Math.min(sessionInfo.lastActivityMs, nowMs - 300001);
      }
    }
  }

  return {
    payload: {
      protocolVersion: 1,
      machine: {
        machineId: options.machineId,
        label: options.label,
        platform: process.platform,
        agentVersion: AGENT_VERSION,
      },
      sessions: [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        provider: session.provider,
        title: session.title,
        project: session.project,
        model: session.model,
        status: sessionStatus(session.lastActivityMs, nowMs),
        activity: sessionStatus(session.lastActivityMs, nowMs) === "active" ? "working" : "idle",
        startedAt: new Date(session.firstAtMs).toISOString(),
        lastSeen: new Date(session.lastActivityMs).toISOString(),
        lastEventMs: session.lastEventMs,
      })),
      events,
    },
    seen,
  };
}

async function postPayload(options, payload) {
  const response = await fetch(`${options.server}/api/remote/ingest`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Remote ingest API ${response.status}`);
  }
  return body;
}

export async function sendAgentPayload(options, payload) {
  const chunks = [];
  for (let index = 0; index < payload.events.length; index += MAX_EVENTS_PER_REQUEST) {
    chunks.push(payload.events.slice(index, index + MAX_EVENTS_PER_REQUEST));
  }
  if (!chunks.length) {
    chunks.push([]);
  }
  let result = null;
  let acceptedEvents = 0;
  let sessionCount = 0;
  for (const events of chunks) {
    result = await postPayload(options, { ...payload, events });
    acceptedEvents += Number(result.acceptedEvents || 0);
    sessionCount = Number(result.sessionCount || sessionCount);
  }
  return { ...result, acceptedEvents, sessionCount };
}

export async function runAgent(rawOptions = {}) {
  const options = normalizeAgentOptions(rawOptions);
  const state = { seen: new Set(), running: false };
  let stopped = false;

  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopped) {
    if (!state.running) {
      state.running = true;
      try {
        const collected = await collectAgentPayload(options, { seen: new Set(state.seen) });
        const result = await sendAgentPayload(options, collected.payload);
        state.seen = collected.seen;
        console.log(
          `Agent ${options.machineId}: sent ${collected.payload.events.length} new events, ${collected.payload.sessions.length} sessions (${result.acceptedEvents || 0} accepted)`,
        );
      } catch (error) {
        console.error(`Agent ${options.machineId}: ${error.message}`);
      } finally {
        state.running = false;
      }
    }
    if (options.once) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
  }
}
