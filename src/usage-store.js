import { stat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildUsageFingerprint,
  completeHourlyTimeline,
  discoverSourceSessionFiles,
  discoverUsageSources,
  loadCodexTitleIndex,
  previousUsageRange,
  resolveDateRange,
  streamUsageFileEvents,
  usageComparisonFromAggregates,
} from "./usage-core.js";

const STORE_SCHEMA_VERSION = 4;
const PROVIDERS = ["claude", "codex"];

function providerClause(provider) {
  if (!provider || provider === "all") {
    return { sql: "", params: [] };
  }
  return { sql: " AND provider = ?", params: [provider] };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localHourKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function usageFromRow(row) {
  const values = row || {};
  return {
    total: Number(values.total || 0),
    input: Number(values.input || 0),
    cached: Number(values.cached || 0),
    output: Number(values.output || 0),
    reasoning: Number(values.reasoning || 0),
  };
}

function safeUsageValue(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) {
    return 0;
  }
  return Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER);
}

function rangeParameters(range) {
  const start = range.start ? range.start.getTime() : null;
  const end = range.end ? range.end.getTime() : null;
  return [start, start, end, end];
}

export class UsageStore {
  constructor(options = {}) {
    this.options = options;
    this.remoteRetentionDays = Math.max(
      0,
      Number(options.remoteRetentionDays || process.env.TOKEN_USAGE_REMOTE_RETENTION_DAYS || 90),
    );
    this.databaseFile =
      options.databaseFile || path.join(options.homeDir || os.homedir(), ".token-usage", "usage-index.sqlite");
    this.database = null;
    this.homes = [];
    this.warnings = [];
    this.generatedAt = "";
    this.fingerprint = "";
    this.checkedAt = "";
  }

  async open() {
    if (this.database) {
      return;
    }
    await mkdir(path.dirname(this.databaseFile), { recursive: true });
    this.database = new DatabaseSync(this.databaseFile);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        event_key TEXT,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        session_title TEXT NOT NULL DEFAULT '',
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
      CREATE INDEX IF NOT EXISTS events_provider_idx ON events(provider);
      CREATE TABLE IF NOT EXISTS remote_machines (
        machine_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        agent_version TEXT NOT NULL DEFAULT '',
        last_seen TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE TABLE IF NOT EXISTS remote_sessions (
        machine_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        project TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unknown',
        activity TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        last_seen TEXT NOT NULL,
        last_event_ms INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (machine_id, provider, session_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS remote_sessions_last_seen_idx ON remote_sessions(last_seen);
    `);
    const version = Number(this.database.prepare("PRAGMA user_version").get().user_version || 0);
    let currentVersion = version;
    if (currentVersion === 0) {
      // Fresh database — apply the latest schema.
      this.database.exec(`PRAGMA user_version = ${STORE_SCHEMA_VERSION}`);
      currentVersion = STORE_SCHEMA_VERSION;
    } else if (currentVersion === 1) {
      // Migrate v1 → v2 → v3: add session_title, then provider columns.
      this.database.exec(`
        ALTER TABLE events ADD COLUMN session_title TEXT NOT NULL DEFAULT '';
        ALTER TABLE events ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
        ALTER TABLE source_files ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
        PRAGMA user_version = 3;
      `);
      currentVersion = 3;
    } else if (currentVersion === 2) {
      // Migrate v2 → v3: add provider columns.
      this.database.exec(`
        ALTER TABLE events ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
        ALTER TABLE source_files ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
        PRAGMA user_version = 3;
      `);
      currentVersion = 3;
    }
    if (currentVersion === 3) {
      this.database.exec(`
        ALTER TABLE events ADD COLUMN event_key TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS events_event_key_idx ON events(event_key);
        CREATE TABLE IF NOT EXISTS remote_machines (
          machine_id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          platform TEXT NOT NULL DEFAULT '',
          agent_version TEXT NOT NULL DEFAULT '',
          last_seen TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}'
        ) STRICT;
        CREATE TABLE IF NOT EXISTS remote_sessions (
          machine_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          project TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'unknown',
          activity TEXT NOT NULL DEFAULT '',
          started_at TEXT NOT NULL DEFAULT '',
          last_seen TEXT NOT NULL,
          last_event_ms INTEGER,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (machine_id, provider, session_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS remote_sessions_last_seen_idx ON remote_sessions(last_seen);
        PRAGMA user_version = 4;
      `);
    } else if (currentVersion !== STORE_SCHEMA_VERSION) {
      throw new Error(`不支持的用量索引版本：${currentVersion}`);
    }
    this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS events_event_key_idx ON events(event_key)");
    this.generatedAt = this.readMeta("generated_at");
    this.fingerprint = this.readMeta("fingerprint");
  }

  readMeta(key) {
    return this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key)?.value || "";
  }

  writeMeta(key, value) {
    this.database
      .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  pruneRemoteData(nowMs = Date.now()) {
    if (!this.remoteRetentionDays || !this.database) {
      return 0;
    }
    const cutoff = nowMs - this.remoteRetentionDays * 24 * 60 * 60 * 1000;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database
        .prepare("DELETE FROM events WHERE source_path LIKE 'remote://%' AND timestamp_ms < ?")
        .run(cutoff);
      this.database.exec(
        "DELETE FROM source_files WHERE kind = 'remote' AND path NOT IN (SELECT DISTINCT source_path FROM events)",
      );
      this.database
        .prepare("DELETE FROM remote_sessions WHERE status = 'completed' AND last_seen < ?")
        .run(new Date(cutoff).toISOString());
      this.database.exec("COMMIT");
      return Number(result.changes || 0);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async withCodexTitles(homes) {
    // Codex keeps conversation names in session_index.jsonl rather than in the
    // rollout files, so load each home's index once and attach it to that home.
    return Promise.all(
      homes.map(async (home) =>
        home.provider === "codex"
          ? { ...home, codexTitles: await loadCodexTitleIndex(home.path) }
          : home,
      ),
    );
  }

  async refreshCodexTitles(homes) {
    // Titles live in session_index.jsonl, outside the per-file size/mtime check,
    // so a rename would otherwise never reach an already-indexed rollout. Apply
    // each home's current titles to any session row that disagrees.
    const update = this.database.prepare(
      "UPDATE events SET session_title = ? WHERE provider = 'codex' AND session_id = ? AND session_title <> ?",
    );
    let changed = 0;
    for (const home of homes) {
      if (home.provider !== "codex" || !home.codexTitles?.size) {
        continue;
      }
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [sessionId, title] of home.codexTitles) {
          changed += Number(update.run(title, sessionId, title).changes || 0);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    return changed;
  }

  async usageFiles(homes) {
    const files = [];
    const warnings = [];
    for (const home of homes) {
      try {
        for (const filePath of await discoverSourceSessionFiles(home)) {
          files.push({ filePath, source: home, info: await stat(filePath) });
        }
      } catch (error) {
        warnings.push(`无法读取 ${home.path}: ${error.message}`);
      }
    }
    return { files, warnings };
  }

  async replaceFile({ filePath, source, info }) {
    const database = this.database;
    const provider = source.provider || "claude";
    const insertSource = database.prepare(`
      INSERT INTO source_files (path, kind, provider, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        provider = excluded.provider,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
    const insertEvent = database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, session_title, home_id, home_label, channel, project, model, provider,
        hour_key, day_key, week_key, month_key, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      insertSource.run(
        filePath,
        source.kind || "claude",
        provider,
        source.id,
        source.label,
        source.path,
        info.size,
        info.mtimeMs,
        new Date().toISOString(),
      );
      database.prepare("DELETE FROM events WHERE source_path = ?").run(filePath);
      await streamUsageFileEvents(filePath, source, (event) => {
        const date = new Date(event.timestampMs);
        insertEvent.run(
          filePath,
          event.timestampMs,
          event.sessionId,
          event.sessionTitle || "",
          event.homeId,
          event.homeLabel,
          event.channel,
          event.project || "Unknown cwd",
          event.model || "Unknown model",
          provider,
          localHourKey(date),
          localDateKey(date),
          localDateKey(startOfLocalWeek(date)),
          localDateKey(date).slice(0, 7),
          event.usage.total,
          event.usage.input,
          event.usage.cached,
          event.usage.output,
          event.usage.reasoning,
        );
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async sync({ force = false, options } = {}) {
    await this.open();
    const syncOptions = options || this.options;
    this.options = syncOptions;
    const homes = await this.withCodexTitles(await discoverUsageSources(syncOptions));
    const status = await buildUsageFingerprint({ ...syncOptions, homes });
    const { files, warnings } = await this.usageFiles(homes);
    const knownFiles = new Set(files.map((file) => file.filePath));
    let updatedFileCount = 0;

    for (const file of files) {
      const existing = this.database
        .prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?")
        .get(file.filePath);
      if (!force && existing && Number(existing.size) === file.info.size && Number(existing.mtime_ms) === file.info.mtimeMs) {
        continue;
      }
      try {
        await this.replaceFile(file);
        updatedFileCount += 1;
      } catch (error) {
        warnings.push(`无法索引 ${file.filePath}: ${error.message}`);
      }
    }

    for (const row of this.database.prepare("SELECT path, kind FROM source_files").all()) {
      if (row.kind !== "remote" && !knownFiles.has(row.path)) {
        this.database.prepare("DELETE FROM source_files WHERE path = ?").run(row.path);
      }
    }

    updatedFileCount += await this.refreshCodexTitles(homes);

    this.homes = homes;
    this.warnings = warnings;
    this.generatedAt = new Date().toISOString();
    this.fingerprint = status.fingerprint;
    this.checkedAt = status.checkedAt;
    this.writeMeta("generated_at", this.generatedAt);
    this.writeMeta("fingerprint", this.fingerprint);
    return { ...status, updatedFileCount };
  }

  metadata() {
    const totals = this.database
      .prepare("SELECT COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM events")
      .get();
    const homeRows = new Map(
      this.database
        .prepare(`
          SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count
          FROM events GROUP BY home_id
        `)
        .all()
        .map((row) => [row.home_id, row]),
    );
    return {
      generatedAt: this.generatedAt,
      eventCount: Number(totals.event_count || 0),
      sessionCount: Number(totals.session_count || 0),
      homeCount: this.homes.length,
      homes: this.homes.map((home) => {
        const row = homeRows.get(home.id);
        return {
          ...home,
          status: row ? "active" : "no-events",
          eventCount: Number(row?.event_count || 0),
          sessionCount: Number(row?.session_count || 0),
        };
      }),
      warnings: this.warnings,
    };
  }

  fingerprintFor(localFingerprint = this.fingerprint) {
    return `${localFingerprint}:${this.readMeta("remote_revision") || "0"}`;
  }

  async ingestRemote(payload) {
    await this.open();
    const machine = payload && payload.machine && typeof payload.machine === "object" ? payload.machine : null;
    if (!machine) {
      throw new Error("machine is required");
    }
    const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
    const events = Array.isArray(payload.events) ? payload.events : [];
    const now = new Date().toISOString();
    const machineId = String(machine.machineId || "").trim();
    if (!machineId) {
      throw new Error("machine.machineId is required");
    }
    const machineLabel = String(machine.label || machineId).slice(0, 200);
    const providerNames = new Set(PROVIDERS);
    for (const session of sessions) {
      if (!providerNames.has(session.provider) || !session.sessionId) {
        throw new Error("Invalid remote session");
      }
    }
    for (const event of events) {
      if (!event.eventKey || !providerNames.has(event.provider) || !event.sessionId) {
        throw new Error("Invalid remote event");
      }
    }

    const upsertMachine = this.database.prepare(`
      INSERT INTO remote_machines (machine_id, label, platform, agent_version, last_seen, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(machine_id) DO UPDATE SET
        label = excluded.label,
        platform = excluded.platform,
        agent_version = excluded.agent_version,
        last_seen = excluded.last_seen,
        metadata_json = excluded.metadata_json
    `);
    const upsertSession = this.database.prepare(`
      INSERT INTO remote_sessions (
        machine_id, provider, session_id, title, project, model, status, activity,
        started_at, last_seen, last_event_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(machine_id, provider, session_id) DO UPDATE SET
        title = excluded.title,
        project = excluded.project,
        model = excluded.model,
        status = excluded.status,
        activity = excluded.activity,
        started_at = CASE WHEN remote_sessions.started_at = '' THEN excluded.started_at ELSE remote_sessions.started_at END,
        last_seen = excluded.last_seen,
        last_event_ms = excluded.last_event_ms,
        updated_at = excluded.updated_at
    `);
    const insertSource = this.database.prepare(`
      INSERT INTO source_files (path, kind, provider, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, 'remote', ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        provider = excluded.provider,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
    const insertEvent = this.database.prepare(`
      INSERT OR IGNORE INTO events (
        event_key, source_path, timestamp_ms, session_id, session_title, home_id, home_label,
        channel, project, model, provider, hour_key, day_key, week_key, month_key,
        total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let acceptedEvents = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const machineMetadata = machine.metadata && typeof machine.metadata === "object" ? machine.metadata : {};
      upsertMachine.run(
        machineId,
        machineLabel,
        String(machine.platform || "").slice(0, 80),
        String(machine.agentVersion || "").slice(0, 80),
        now,
        JSON.stringify(machineMetadata),
      );
      for (const session of sessions) {
        upsertSession.run(
          machineId,
          session.provider,
          String(session.sessionId),
          String(session.title || "").slice(0, 500),
          String(session.project || "").slice(0, 500),
          String(session.model || "").slice(0, 200),
          String(session.status || "unknown").slice(0, 40),
          String(session.activity || "").slice(0, 100),
          String(session.startedAt || ""),
          String(session.lastSeen || now),
          Number.isFinite(Number(session.lastEventMs)) ? Number(session.lastEventMs) : null,
          now,
        );
      }
      for (const event of events) {
        const timestampMs = Number(event.timestampMs);
        if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
          continue;
        }
        const date = new Date(timestampMs);
        const sourcePath = `remote://${machineId}/${event.provider}/${encodeURIComponent(event.sessionId)}`;
        const homeId = `${machineId}:${event.homeId || event.provider}`;
        const homeLabel = `${machineLabel} / ${event.homeLabel || event.provider}`;
        insertSource.run(sourcePath, event.provider, homeId, homeLabel, `remote:${machineId}`, timestampMs, now);
        const result = insertEvent.run(
          String(event.eventKey),
          sourcePath,
          timestampMs,
          String(event.sessionId),
          String(event.sessionTitle || "").slice(0, 500),
          homeId,
          homeLabel,
          String(event.channel || "").slice(0, 100),
          String(event.project || "").slice(0, 500),
          String(event.model || "").slice(0, 200),
          event.provider,
          localHourKey(date),
          localDateKey(date),
          localDateKey(startOfLocalWeek(date)),
          localDateKey(date).slice(0, 7),
          safeUsageValue(event.usage?.total),
          safeUsageValue(event.usage?.input),
          safeUsageValue(event.usage?.cached),
          safeUsageValue(event.usage?.output),
          safeUsageValue(event.usage?.reasoning),
        );
        acceptedEvents += Number(result.changes || 0);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const revision = Number(this.readMeta("remote_revision") || 0) + 1;
    this.writeMeta("remote_revision", revision);
    const lastPrunedAt = Date.parse(this.readMeta("remote_pruned_at") || "");
    if (!Number.isFinite(lastPrunedAt) || Date.now() - lastPrunedAt > 6 * 60 * 60 * 1000) {
      this.pruneRemoteData();
      this.writeMeta("remote_pruned_at", now);
    }
    return { machineId, acceptedEvents, sessionCount: sessions.length, receivedAt: now };
  }

  remoteSnapshot(now = Date.now()) {
    const machines = this.database.prepare("SELECT * FROM remote_machines ORDER BY label COLLATE NOCASE").all().map((row) => {
      const ageMs = Math.max(0, now - Date.parse(row.last_seen));
      return {
        machineId: row.machine_id,
        label: row.label,
        platform: row.platform,
        agentVersion: row.agent_version,
        lastSeen: row.last_seen,
        status: ageMs <= 180000 ? "online" : "offline",
      };
    });
    const machineStatus = new Map(machines.map((machine) => [machine.machineId, machine.status]));
    const sessions = this.database.prepare(`
      SELECT machine_id, provider, session_id, title, project, model, status, activity,
             started_at, last_seen, last_event_ms
      FROM remote_sessions
      ORDER BY last_seen DESC
    `).all();
    const tasks = sessions.map((row) => ({
      machineId: row.machine_id,
      provider: row.provider,
      sessionId: row.session_id,
      title: row.title,
      project: row.project,
      model: row.model,
      status: machineStatus.get(row.machine_id) === "offline" ? "offline" : row.status,
      activity: row.activity,
      startedAt: row.started_at,
      lastSeen: row.last_seen,
      lastEventMs: row.last_event_ms,
    })).filter((task) => task.status !== "completed");
    const totals = this.database.prepare(`
      SELECT COALESCE(SUM(total), 0) AS total,
             COALESCE(SUM(input), 0) AS input,
             COALESCE(SUM(cached), 0) AS cached,
             COALESCE(SUM(output), 0) AS output,
             COALESCE(SUM(reasoning), 0) AS reasoning,
             COUNT(*) AS event_count,
             COUNT(DISTINCT session_id) AS session_count
      FROM events WHERE source_path LIKE 'remote://%'
    `).get();
    return {
      generatedAt: new Date(now).toISOString(),
      machines,
      tasks,
      totals: usageFromRow(totals),
      eventCount: Number(totals.event_count || 0),
      sessionCount: Number(totals.session_count || 0),
    };
  }

  aggregateRange(range, provider) {
    const filter = providerClause(provider);
    return this.database
      .prepare(`
        SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT session_id) AS session_count,
          COUNT(DISTINCT home_id) AS home_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)${filter.sql}
      `)
      .get(...rangeParameters(range), ...filter.params);
  }

  groupedRange(column, range, provider, orderBy = "total DESC") {
    const allowedColumns = new Set(["channel", "home_label", "model", "project", "hour_key", "day_key", "week_key", "month_key"]);
    if (!allowedColumns.has(column)) {
      throw new Error(`不支持的聚合字段：${column}`);
    }
    const filter = providerClause(provider);
    const rows = this.database
      .prepare(`
        SELECT
          ${column} AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)${filter.sql}
        GROUP BY ${column}
        ORDER BY ${orderBy}
      `)
      .all(...rangeParameters(range), ...filter.params);
    return rows.map((row) => ({
      key: row.key,
      name: row.key,
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      total: usageFromRow(row),
    }));
  }

  timelineRange(range, bucket, provider) {
    const bucketColumns = {
      hour: "hour_key",
      day: "day_key",
      week: "week_key",
      month: "month_key",
    };
    const bucketColumn = bucketColumns[bucket] || bucketColumns.day;
    const filter = providerClause(provider);
    const rows = this.groupedRange(bucketColumn, range, provider, "key ASC");
    const modelRows = this.database
      .prepare(`
        SELECT
          ${bucketColumn} AS bucket_key,
          model AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)${filter.sql}
        GROUP BY ${bucketColumn}, model
        ORDER BY ${bucketColumn} ASC, total DESC
      `)
      .all(...rangeParameters(range), ...filter.params);
    const modelsByBucket = new Map();
    for (const row of modelRows) {
      const models = modelsByBucket.get(row.bucket_key) || [];
      models.push({
        key: row.key,
        name: row.key,
        count: Number(row.count || 0),
        sessions: Number(row.sessions || 0),
        total: usageFromRow(row),
      });
      modelsByBucket.set(row.bucket_key, models);
    }
    return completeHourlyTimeline(
      rows.map((row) => ({ ...row, models: modelsByBucket.get(row.key) || [] })),
      range,
      bucket,
    );
  }

  sessionsRange(range, provider) {
    const filter = providerClause(provider);
    const rows = this.database
      .prepare(`
        SELECT
          session_id AS key,
          session_title AS title,
          project,
          COUNT(*) AS count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning,
          MIN(timestamp_ms) AS first_at,
          MAX(timestamp_ms) AS last_at
        FROM events
        WHERE (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)${filter.sql}
        GROUP BY session_id
        ORDER BY last_at DESC, total DESC
      `)
      .all(...rangeParameters(range), ...filter.params);
    return rows.map((row) => {
      const title = row.title || "";
      // Build a display name: prefer session title, fall back to project + date.
      const name =
        title ||
        `${row.project || "Unknown"} ${localDateKey(new Date(Number(row.first_at)))}`;
      return {
        key: row.key,
        name,
        title,
        project: row.project || "",
        count: Number(row.count || 0),
        total: usageFromRow(row),
        firstAt: new Date(Number(row.first_at)).toISOString(),
        lastAt: new Date(Number(row.last_at)).toISOString(),
      };
    });
  }

  summarize(filters = {}) {
    const bounds = this.database.prepare("SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events").get();
    const boundaryEvents = [];
    if (bounds.minimum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.minimum)).toISOString() });
    }
    if (bounds.maximum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.maximum)).toISOString() });
    }
    const range = resolveDateRange(filters, boundaryEvents);
    const provider = filters.provider === "all" || !filters.provider ? "" : filters.provider;
    const aggregate = this.aggregateRange(range, provider);
    const totals = usageFromRow(aggregate);
    const previousRange = previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange, provider) : null;
    const comparison = usageComparisonFromAggregates({
      range,
      currentTotals: totals,
      previousTotals: usageFromRow(previousAggregate),
      previousEventCount: Number(previousAggregate?.event_count || 0),
      previousSessionCount: Number(previousAggregate?.session_count || 0),
      now: filters.now ? new Date(filters.now) : new Date(),
    });
    const bucket = filters.bucket || "day";
    const providers = [];
    for (const candidate of PROVIDERS) {
      const row = this.aggregateRange(range, candidate);
      if (Number(row.event_count || 0) > 0) {
        providers.push({
          provider: candidate,
          totals: usageFromRow(row),
        });
      }
    }
    return {
      generatedAt: this.generatedAt,
      range: {
        preset: range.preset,
        start: range.start ? range.start.toISOString() : null,
        end: range.end ? range.end.toISOString() : null,
        bucket,
        rolling: Boolean(range.rolling),
      },
      totals,
      comparison,
      eventCount: Number(aggregate.event_count || 0),
      sessionCount: Number(aggregate.session_count || 0),
      homeCount: Number(aggregate.home_count || 0),
      providers,
      timeline: this.timelineRange(range, bucket, provider),
      channels: this.groupedRange("channel", range, provider),
      homes: this.groupedRange("home_label", range, provider),
      models: this.groupedRange("model", range, provider),
      projects: this.groupedRange("project", range, provider),
      sessions: this.sessionsRange(range, provider),
    };
  }

  close() {
    if (!this.database) {
      return;
    }
    this.database.close();
    this.database = null;
  }
}
