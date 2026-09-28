import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectAgentPayload, sessionStatus } from "../src/agent.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";

function remotePayload(eventKey = "event-1") {
  const timestampMs = Date.now();
  return {
    protocolVersion: 1,
    machine: { machineId: "machine-a", label: "Machine A", platform: "test", agentVersion: "0.1.0" },
    sessions: [{
      sessionId: "machine-a:codex:session-a",
      provider: "codex",
      title: "Test task",
      project: "demo",
      model: "test-model",
      status: "active",
      activity: "working",
      startedAt: new Date(timestampMs - 1000).toISOString(),
      lastSeen: new Date(timestampMs).toISOString(),
      lastEventMs: timestampMs,
    }],
    events: [{
      eventKey,
      provider: "codex",
      sessionId: "machine-a:codex:session-a",
      sessionTitle: "Test task",
      homeId: "main",
      homeLabel: "Main Codex",
      channel: "CLI",
      project: "demo",
      model: "test-model",
      timestampMs,
      usage: { total: 20, input: 10, cached: 2, output: 5, reasoning: 3 },
    }],
  };
}

test("remote events are indexed once and included in usage summaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-test-"));
  const store = new UsageStore({ databaseFile: path.join(root, "usage.sqlite"), homeDir: path.join(root, "home") });
  const first = await store.ingestRemote(remotePayload());
  const second = await store.ingestRemote(remotePayload());
  assert.equal(first.acceptedEvents, 1);
  assert.equal(second.acceptedEvents, 0);
  assert.deepEqual(store.summarize({ preset: "all", bucket: "day" }).totals, {
    total: 20,
    input: 10,
    cached: 2,
    output: 5,
    reasoning: 3,
  });
  assert.equal(store.remoteSnapshot().machines[0].status, "online");
  assert.equal(store.remoteSnapshot().tasks[0].title, "Test task");
  store.close();
});

test("conversation summaries are ordered by most recent activity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-order-test-"));
  const store = new UsageStore({ databaseFile: path.join(root, "usage.sqlite"), homeDir: path.join(root, "home") });
  const older = remotePayload("older-event");
  const newer = remotePayload("newer-event");
  const olderTime = Date.now() - 60000;
  const newerTime = Date.now();
  older.sessions[0].sessionId = "machine-a:codex:older";
  older.sessions[0].title = "Older task";
  older.sessions[0].lastSeen = new Date(olderTime).toISOString();
  older.sessions[0].lastEventMs = olderTime;
  older.events[0].sessionId = older.sessions[0].sessionId;
  older.events[0].sessionTitle = "Older task";
  older.events[0].timestampMs = olderTime;
  newer.sessions[0].sessionId = "machine-a:codex:newer";
  newer.sessions[0].title = "Newer task";
  newer.sessions[0].lastSeen = new Date(newerTime).toISOString();
  newer.sessions[0].lastEventMs = newerTime;
  newer.events[0].sessionId = newer.sessions[0].sessionId;
  newer.events[0].sessionTitle = "Newer task";
  newer.events[0].timestampMs = newerTime;
  await store.ingestRemote(older);
  await store.ingestRemote(newer);
  const sessions = store.summarize({ preset: "all", bucket: "day" }).sessions;
  assert.equal(sessions[0].name, "Newer task");
  assert.equal(sessions[1].name, "Older task");
  store.close();
});

test("remote ingest endpoint authenticates agents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-server-test-"));
  const server = createUsageServer({
    databaseFile: path.join(root, "usage.sqlite"),
    homeDir: path.join(root, "home"),
    remoteToken: "secret",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const body = JSON.stringify(remotePayload("http-event"));
  const unauthorized = await fetch(`${base}/api/remote/ingest`, {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body,
  });
  assert.equal(unauthorized.status, 401);
  const accepted = await fetch(`${base}/api/remote/ingest`, {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body,
  });
  assert.equal(accepted.status, 200);
  const status = await fetch(`${base}/api/remote/status`);
  const snapshot = await status.json();
  assert.equal(snapshot.machines.length, 1);
  await new Promise((resolve) => server.close(resolve));
});

test("agent collects Codex events from a fixture home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-agent-test-"));
  const codexDir = path.join(root, ".codex", "sessions", "2026", "09");
  await mkdir(codexDir, { recursive: true });
  await writeFile(path.join(codexDir, "rollout-fixture.jsonl"), [
    JSON.stringify({ timestamp: "2026-09-27T12:00:00.000Z", type: "session_meta", payload: { id: "fixture", source: "cli", originator: "codex_cli", cwd: "/tmp/demo" } }),
    JSON.stringify({ timestamp: "2026-09-27T12:00:01.000Z", type: "turn_context", payload: { model: "test-model" } }),
    JSON.stringify({ timestamp: "2026-09-27T12:00:02.000Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 4, cached_input_tokens: 1, output_tokens: 2, total_tokens: 7 } } } }),
  ].join("\n"));
  const result = await collectAgentPayload({ machineId: "fixture", label: "Fixture", homeDir: root });
  assert.equal(result.payload.events.length, 1);
  assert.equal(result.payload.events[0].usage.total, 7);
  assert.equal(result.payload.sessions[0].provider, "codex");
});

test("missing lifecycle signals do not imply waiting or completion", () => {
  const now = Date.now();
  assert.equal(sessionStatus(now - 1000, now), "active");
  assert.equal(sessionStatus(now - 120000, now), "unknown");
  assert.equal(sessionStatus(now - 600000, now), "unknown");
});

test("agent tracks input and completion without requiring new token events", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-lifecycle-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".codex", "sessions");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "rollout-status.jsonl");
  const nowMs = Date.parse("2026-09-28T12:00:00Z");
  const options = { machineId: "fixture", label: "Fixture", homeDir: root };
  await writeFile(file, [
    { timestamp: "2026-09-28T10:00:00Z", type: "session_meta", payload: { id: "status", cwd: "/tmp/demo" } },
    { timestamp: "2026-09-28T10:00:01Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-09-28T10:00:02Z", type: "response_item", payload: { type: "function_call", name: "request_user_input", call_id: "question" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const waiting = await collectAgentPayload(options, { nowMs });
  assert.equal(waiting.payload.events.length, 0);
  assert.equal(waiting.payload.sessions.length, 1);
  assert.equal(waiting.payload.sessions[0].status, "waiting");
  assert.equal(waiting.payload.sessions[0].lastSeen, "2026-09-28T10:00:02.000Z");
  await appendFile(file, [
    { timestamp: "2026-09-28T11:00:00Z", type: "response_item", payload: { type: "function_call_output", call_id: "question", output: "answer" } },
    { timestamp: "2026-09-28T11:00:01Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "Done." } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const completed = await collectAgentPayload(options, { nowMs });
  assert.equal(completed.payload.sessions[0].status, "completed");
  assert.equal(completed.payload.sessions[0].lastSeen, "2026-09-28T11:00:01.000Z");
});

test("Claude lifecycle records are observed while reading usage", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-claude-state-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".claude", "projects", "demo");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "status.jsonl");
  await writeFile(file, JSON.stringify({
    type: "assistant", sessionId: "claude-status", timestamp: "2026-09-28T10:00:00Z",
    message: {
      id: "message-1", model: "test-model", stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "AskUserQuestion", id: "question" }],
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  }) + "\n");
  const options = { machineId: "fixture", label: "Fixture", homeDir: root };
  const waiting = await collectAgentPayload(options);
  assert.equal(waiting.payload.events.length, 1);
  assert.equal(waiting.payload.sessions[0].status, "waiting");
  await appendFile(file, JSON.stringify({
    type: "user", sessionId: "claude-status", timestamp: "2026-09-28T10:01:00Z",
    message: { content: [{ type: "tool_result", tool_use_id: "question", content: "answer" }] },
  }) + "\n");
  const resumed = await collectAgentPayload(options, { seen: waiting.seen });
  assert.equal(resumed.payload.events.length, 0);
  assert.equal(resumed.payload.sessions[0].status, "active");
});

test("completed and interrupted tasks retain their status when a computer goes offline", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-completed-"));
  const store = new UsageStore({ databaseFile: path.join(root, "usage.sqlite"), homeDir: path.join(root, "home") });
  context.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const payload = remotePayload();
  payload.sessions = ["completed", "failed", "interrupted"].map((status) => ({ ...payload.sessions[0], sessionId: status, status }));
  await store.ingestRemote(payload);
  assert.deepEqual(store.remoteSnapshot().tasks.map((task) => task.status).sort(), ["completed", "failed", "interrupted"]);
  const offline = store.remoteSnapshot(Date.now() + 600000);
  assert.equal(offline.machines[0].status, "offline");
  assert.deepEqual(offline.tasks.map((task) => task.status).sort(), ["completed", "failed", "interrupted"]);
});

test("archived Codex errors and synthetic Claude errors are reported without token events", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-errors-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const codexDirectory = path.join(root, ".codex", "archived_sessions");
  const claudeDirectory = path.join(root, ".claude", "projects", "demo");
  await mkdir(codexDirectory, { recursive: true });
  await mkdir(claudeDirectory, { recursive: true });
  const timestamp = new Date().toISOString();
  await writeFile(path.join(codexDirectory, "rollout-error.jsonl"), [
    { type: "session_meta", timestamp, payload: { id: "quota-error" } },
    { type: "event_msg", timestamp, payload: { type: "task_complete", error: { codex_error_info: "rate_limit_exceeded" } } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  await writeFile(path.join(claudeDirectory, "error.jsonl"), JSON.stringify({
    type: "assistant", sessionId: "api-error", timestamp, isApiErrorMessage: true, error: "server_error",
    message: { model: "<synthetic>", content: [{ type: "text", text: "API Error" }] },
  }) + "\n");
  const result = await collectAgentPayload({ machineId: "fixture", label: "Fixture", homeDir: root });
  assert.equal(result.payload.events.length, 0);
  assert.equal(result.payload.sessions.length, 2);
  assert.ok(result.payload.sessions.every((session) => session.status === "failed"));
  assert.equal(result.payload.machine.agentVersion, "0.2.1");
});

test("task snapshots use current machine labels and only include activity within 18 hours", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-task-window-"));
  const store = new UsageStore({ databaseFile: path.join(root, "usage.sqlite"), homeDir: path.join(root, "home") });
  context.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const now = Date.parse("2026-09-28T12:00:00Z");
  const cutoff = now - 18 * 60 * 60 * 1000;
  const payload = remotePayload();
  payload.machine.label = "Old display name";
  payload.sessions = [
    ["recent", new Date(now - 1000).toISOString()],
    ["boundary", new Date(cutoff).toISOString()],
    ["expired", new Date(cutoff - 1).toISOString()],
    ["invalid", "invalid-date"],
    ["future", new Date(now + 1000).toISOString()],
    ["offset", "2026-09-27T14:00:01-04:00"],
  ].map(([sessionId, lastSeen]) => ({ ...payload.sessions[0], sessionId, lastSeen }));
  await store.ingestRemote(payload);
  await store.ingestRemote({ ...payload, machine: { ...payload.machine, label: "MacBook Air" }, sessions: [], events: [] });
  const snapshot = store.remoteSnapshot(now);
  assert.deepEqual(snapshot.tasks.map((task) => task.sessionId), ["recent", "offset", "boundary"]);
  assert.ok(snapshot.tasks.every((task) => task.machineLabel === "MacBook Air"));
  assert.equal(snapshot.totals.total, 20);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS count FROM remote_sessions").get().count, 6);
  assert.deepEqual(store.remoteSnapshot(now + 2000).tasks.map((task) => task.sessionId), ["future", "recent"]);
});

test("schema v3 databases migrate before creating the remote event index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "token-usage-migration-test-"));
  const databaseFile = path.join(root, "usage.sqlite");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE source_files (
      path TEXT PRIMARY KEY, kind TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'claude',
      home_id TEXT NOT NULL, home_label TEXT NOT NULL, home_path TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ms REAL NOT NULL, indexed_at TEXT NOT NULL
    );
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, source_path TEXT NOT NULL, timestamp_ms INTEGER NOT NULL,
      session_id TEXT NOT NULL, session_title TEXT NOT NULL DEFAULT '', home_id TEXT NOT NULL,
      home_label TEXT NOT NULL, channel TEXT NOT NULL, project TEXT NOT NULL, model TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'claude', hour_key TEXT NOT NULL, day_key TEXT NOT NULL,
      week_key TEXT NOT NULL, month_key TEXT NOT NULL, total INTEGER NOT NULL, input INTEGER NOT NULL,
      cached INTEGER NOT NULL, output INTEGER NOT NULL, reasoning INTEGER NOT NULL
    );
    PRAGMA user_version = 3;
  `);
  database.close();
  const store = new UsageStore({ databaseFile, homeDir: path.join(root, "home") });
  await store.open();
  assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, 4);
  assert.equal(
    store.database.prepare("SELECT name FROM pragma_index_list('events') WHERE name = 'events_event_key_idx'").get()?.name,
    "events_event_key_idx",
  );
  store.close();
});
