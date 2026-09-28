import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

test("session status changes with activity age", () => {
  const now = Date.now();
  assert.equal(sessionStatus(now - 1000, now), "active");
  assert.equal(sessionStatus(now - 120000, now), "waiting");
  assert.equal(sessionStatus(now - 600000, now), "completed");
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
