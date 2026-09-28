import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const CLAUDE_PROJECTS_DIR = "projects";
const CODEX_SESSION_DIRS = ["sessions", "archived_sessions"];
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const USAGE_FIELDS = [
  "total",
  "input",
  "cached",
  "output",
  "reasoning",
];
const PROVIDERS = ["claude", "codex"];

export function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function addUsage(target, usage) {
  for (const field of USAGE_FIELDS) {
    target[field] += usage[field] || 0;
  }
  return target;
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeId(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function discoverClaudeSessionFiles(homePath) {
  // Claude Code stores one JSONL per session directly under ~/.claude/projects/<hash>/.
  if (!(await exists(homePath))) {
    return [];
  }
  const files = [];
  for (const entry of await readdir(homePath, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path.join(homePath, entry.name));
    }
  }
  return files.sort();
}

async function walkJsonlFiles(root, files = []) {
  if (!(await exists(root))) {
    return files;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".tmp" || entry.name === "node_modules") {
        continue;
      }
      await walkJsonlFiles(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function discoverCodexSessionFiles(homePath) {
  // Codex stores rollouts under <home>/sessions/<yyyy>/<mm>/ and archived_sessions/.
  const groups = await Promise.all(
    CODEX_SESSION_DIRS.map((dir) => walkJsonlFiles(path.join(homePath, dir), [])),
  );
  return groups.flat().sort();
}

export async function discoverSourceSessionFiles(source) {
  if (source.provider === "codex") {
    return discoverCodexSessionFiles(source.path);
  }
  return discoverClaudeSessionFiles(source.path);
}

async function projectLabelForSource(dirPath, files) {
  // Use the first real cwd found in the session files as a human-readable project label.
  for (const file of files) {
    for await (const row of readJsonlRows(file)) {
      if (typeof row.cwd === "string" && row.cwd) {
        return row.cwd;
      }
    }
  }
  return path.basename(dirPath);
}

export async function discoverClaudeSources(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const root = options.claudeDir || path.join(homeDir, ".claude", CLAUDE_PROJECTS_DIR);
  const sources = [];
  if (!(await exists(root))) {
    return sources;
  }
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  let index = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirPath = path.join(root, entry.name);
    const files = await discoverClaudeSessionFiles(dirPath);
    if (!files.length) {
      continue;
    }
    index += 1;
    sources.push({
      id: normalizeId(`claude-${entry.name}-${index}`),
      label: (await projectLabelForSource(dirPath, files)) || entry.name,
      path: dirPath,
      kind: "claude",
      provider: "claude",
    });
  }
  return sources;
}

async function codexHomeLooksUsable(homePath) {
  const checks = await Promise.all([
    exists(path.join(homePath, "sessions")),
    exists(path.join(homePath, "archived_sessions")),
    exists(path.join(homePath, "state_5.sqlite")),
  ]);
  return checks.some(Boolean);
}

function uniquePaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const candidate of paths.filter(Boolean)) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    unique.push(resolved);
  }
  return unique;
}

function jetBrainsRoots({ homeDir, platform, env }) {
  const roots = [path.join(homeDir, "Library", "Caches", "JetBrains")];

  if (platform === "win32") {
    roots.push(
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "JetBrains") : "",
      env.APPDATA ? path.join(env.APPDATA, "JetBrains") : "",
      path.join(homeDir, "AppData", "Local", "JetBrains"),
      path.join(homeDir, "AppData", "Roaming", "JetBrains"),
    );
  }

  return uniquePaths(roots);
}

export async function discoverCodexHomes(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || os.platform();
  const envHomes = options.extraHomes || env.TOKEN_USAGE_HOMES || "";
  const homes = [];
  const seen = new Set();

  async function addHome(label, homePath, kind = "codex") {
    const resolved = path.resolve(homePath);
    if (seen.has(resolved) || !(await codexHomeLooksUsable(resolved))) {
      return;
    }
    seen.add(resolved);
    homes.push({
      id: normalizeId(`${kind}-${label}-${homes.length + 1}`),
      label,
      path: resolved,
      kind,
      provider: "codex",
    });
  }

  await addHome("Main Codex", path.join(homeDir, ".codex"), "main");

  for (const jetbrainsRoot of jetBrainsRoots({ homeDir, platform, env })) {
    if (!(await exists(jetbrainsRoot))) {
      continue;
    }
    for (const entry of await readdir(jetbrainsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const productName = entry.name;
      await addHome(
        `JetBrains ${productName}`,
        path.join(jetbrainsRoot, productName, "aia", "codex"),
        "jetbrains",
      );
    }
  }

  for (const extraHome of envHomes.split(path.delimiter).filter(Boolean)) {
    await addHome(`Extra ${path.basename(extraHome)}`, extraHome, "extra");
  }

  return homes;
}

export async function discoverUsageSources(options = {}) {
  const [claude, codex] = await Promise.all([
    discoverClaudeSources(options),
    discoverCodexHomes(options),
  ]);
  return [...claude, ...codex];
}

export async function loadCodexTitleIndex(homePath) {
  // Codex records the human-readable conversation name (its "thread name") in
  // <home>/session_index.jsonl, keyed by session id — never inside the rollout
  // files themselves. An id can appear on several lines; the latest one wins.
  const titles = new Map();
  const indexPath = path.join(homePath, "session_index.jsonl");
  if (!(await exists(indexPath))) {
    return titles;
  }
  try {
    for await (const row of readJsonlRows(indexPath)) {
      const id = row.id || row.session_id;
      const title = row.thread_name || row.title;
      if (id && title) {
        titles.set(id, title);
      }
    }
  } catch {
    // A missing or unreadable index just means titles fall back to project + date.
  }
  return titles;
}

export async function buildUsageFingerprint(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const hash = createHash("sha256");
  let fileCount = 0;

  for (const home of homes) {
    hash.update(`${home.id}\t${home.label}\t${home.path}\t${home.kind || ""}\t${home.provider || ""}\n`);
    const files = await discoverSourceSessionFiles(home);
    for (const file of files) {
      const info = await stat(file);
      fileCount += 1;
      hash.update(`${file}\t${info.size}\t${info.mtimeMs}\n`);
    }
  }

  return {
    fingerprint: hash.digest("hex"),
    fileCount,
    homeCount: homes.length,
    checkedAt: new Date().toISOString(),
  };
}

export function classifyChannel({ source }) {
  // Claude Code identifies the client via the top-level `entrypoint` field.
  switch (source) {
    case "claude-vscode":
      return "Claude VSCode";
    case "claude":
    case "claude-code":
    case "cli":
      return "CLI";
    case "claude-desktop":
      return "Claude Desktop";
    default:
      return source || "Unknown";
  }
}

export function classifyCodexChannel({ originator, source, homeLabel }) {
  const text = `${originator || ""} ${source || ""} ${homeLabel || ""}`.toLowerCase();
  if (text.includes("jetbrains")) {
    return "JetBrains PyCharm";
  }
  if (text.includes("codex desktop")) {
    return "Codex Desktop";
  }
  if (source === "cli" || text.includes("codex-tui") || text.includes("codex_cli")) {
    return "CLI";
  }
  if (source === "exec" || text.includes("codex_exec")) {
    return "Codex Exec";
  }
  if (source === "vscode") {
    return "Editor Integration";
  }
  return originator || source || homeLabel || "Unknown";
}

function codexUsageFromRaw(raw = {}) {
  return {
    total: Number(raw.total_tokens || 0),
    input: Number(raw.input_tokens || 0),
    cached: Number(raw.cached_input_tokens || 0),
    output: Number(raw.output_tokens || 0),
    reasoning: Number(raw.reasoning_output_tokens || 0),
  };
}

function diffUsage(current, previous) {
  const diff = emptyUsage();
  for (const field of USAGE_FIELDS) {
    diff[field] = Math.max(0, (current[field] || 0) - (previous[field] || 0));
  }
  return diff;
}

function isZeroUsage(usage) {
  return USAGE_FIELDS.every((field) => !usage[field]);
}

function codexSessionIdFromFilePath(filePath) {
  const base = path.basename(filePath, ".jsonl");
  return base.replace(/^rollout-/, "") || filePath;
}

function readCodexTokenUsage(payload) {
  const info = payload?.info || {};
  const cumulative = info.total_token_usage ? codexUsageFromRaw(info.total_token_usage) : null;
  const last = info.last_token_usage ? codexUsageFromRaw(info.last_token_usage) : null;
  return { cumulative, last };
}

function sessionIdFromFilePath(filePath) {
  const base = path.basename(filePath, ".jsonl");
  return base || filePath;
}

// Collapse project paths to their top-level root for grouping: normalize the drive
// letter casing and path separators, then keep only the drive + first directory.
// e.g. "C:\研究生\model\bike" -> "c:\研究生".
export function normalizeProjectPath(value) {
  const input = String(value || "").trim();
  if (!input) {
    return "";
  }
  const normalized = input.replace(/[\\/]+/g, "\\").replace(/\\$/g, "");
  // Windows absolute path: drive letter + first directory (or bare drive root).
  const driveMatch = normalized.match(/^([a-zA-Z]):(\\.*)?$/);
  if (driveMatch) {
    const drive = `${driveMatch[1].toLowerCase()}:\\`;
    const rest = (driveMatch[2] || "").replace(/^\\/, "");
    const firstDir = rest.split("\\")[0];
    return firstDir ? drive + firstDir : drive;
  }
  // POSIX-style absolute or relative path: keep the top-level segment.
  const cleaned = normalized.replace(/^\\+/, "");
  const firstSegment = cleaned.split("\\").filter(Boolean)[0];
  return firstSegment ? `\\${firstSegment}` : normalized;
}

function claudeUsageFromRaw(raw = {}) {
  // Claude Code reports cache tokens additively to input_tokens, not as a subset.
  const input = Number(raw.input_tokens || 0);
  const cached =
    Number(raw.cache_creation_input_tokens || 0) + Number(raw.cache_read_input_tokens || 0);
  const output = Number(raw.output_tokens || 0);
  const reasoning = 0; // Claude Code usage has no reasoning-token field.
  return { total: input + cached + output, input, cached, output, reasoning };
}

async function collectClaudeAssistantRows(filePath) {
  // Each unique API response (message.id) is written as a parent-chain of 2-17 rows
  // with identical usage. Deduplicate by message.id so each response counts once.
  const byId = new Map();
  let sessionId = "";
  let title = "";

  for await (const row of readJsonlRows(filePath)) {
    if (row.type === "assistant" && row.message?.usage) {
      // Claude Code synthetic rows have no real model or usage — skip them.
      if (row.message.model === "<synthetic>") {
        continue;
      }
      const id = row.message.id;
      if (!id) {
        continue;
      }
      if (!byId.has(id)) {
        byId.set(id, {
          messageId: id,
          timestamp: row.timestamp || "",
          model: row.message.model || "",
          entrypoint: row.entrypoint || "",
          cwd: typeof row.cwd === "string" ? row.cwd : "",
          usage: claudeUsageFromRaw(row.message.usage),
        });
      }
    }
    if (row.type === "ai-title" && row.aiTitle && !title) {
      title = row.aiTitle;
    }
    if (row.sessionId) {
      sessionId = row.sessionId;
    }
  }

  return { events: [...byId.values()], sessionId, title };
}

export async function parseClaudeSessionFile(filePath, source) {
  const { events, sessionId, title } = await collectClaudeAssistantRows(filePath);
  if (!events.length) {
    return null;
  }

  let firstAt = "";
  let lastAt = "";
  let finalUsage = emptyUsage();
  let model = "";
  const channel = classifyChannel({ source: events[0].entrypoint });

  const normalized = events
    .map((event) => {
      const entrypoint = event.entrypoint;
      if (!firstAt || event.timestamp < firstAt) {
        firstAt = event.timestamp;
      }
      if (!lastAt || event.timestamp > lastAt) {
        lastAt = event.timestamp;
      }
      if (!model) {
        model = event.model;
      }
      addUsage(finalUsage, event.usage);
      return {
        id: `${sessionId || source.id}:${event.messageId}`,
        sessionId: sessionId || source.id,
        sessionTitle: title || "",
        timestamp: event.timestamp,
        homeId: source.homeId || source.id,
        homeLabel: source.homeLabel || source.label,
        homePath: source.homePath || source.path,
        channel: classifyChannel({ source: entrypoint }),
        source: entrypoint,
        originator: entrypoint,
        cwd: normalizeProjectPath(event.cwd),
        model: event.model,
        provider: source.provider || "claude",
        total: event.usage,
      };
    })
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  return {
    session: {
      id: sessionId || source.id,
      title: title || "",
      filePath,
      firstAt,
      lastAt,
      homeId: source.homeId || source.id,
      homeLabel: source.homeLabel || source.label,
      homePath: source.homePath || source.path,
      channel,
      source: events[0].entrypoint,
      originator: events[0].entrypoint,
      cwd: normalizeProjectPath(events[0].cwd),
      model,
      cliVersion: "",
      modelProvider: "",
      provider: source.provider || "claude",
      eventCount: normalized.length,
      total: finalUsage,
    },
    events: normalized,
  };
}

async function* readJsonlRows(filePath) {
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore malformed JSONL rows from interrupted writes.
    }
  }
}

function createStringInterner() {
  const values = [];
  const ids = new Map();
  return {
    values,
    intern(value) {
      const text = value || "";
      const existing = ids.get(text);
      if (existing !== undefined) {
        return existing;
      }
      const id = values.length;
      ids.set(text, id);
      values.push(text);
      return id;
    },
  };
}

async function streamClaudeUsageFileEvents(filePath, source, onEvent) {
  const { events, sessionId, title } = await collectClaudeAssistantRows(filePath);
  for (const event of events) {
    const timestampMs = Date.parse(event.timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    await onEvent({
      timestampMs,
      sessionId: sessionId || source.id,
      sessionTitle: title || "",
      homeId: source.homeId || source.id,
      homeLabel: source.homeLabel || source.label,
      channel: classifyChannel({ source: event.entrypoint }),
      project: normalizeProjectPath(event.cwd || source.label),
      model: event.model,
      usage: event.usage,
    });
  }
}

async function streamCodexUsageFileEvents(filePath, source, onEvent) {
  const meta = {
    id: codexSessionIdFromFilePath(filePath),
    source: "",
    originator: "",
    cwd: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();

  for await (const row of readJsonlRows(filePath)) {
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    const { cumulative, last } = readCodexTokenUsage(row.payload);
    let increment = emptyUsage();
    if (cumulative) {
      increment = diffUsage(cumulative, previousCumulative);
      previousCumulative = cumulative;
    } else if (last) {
      increment = last;
    }

    if (isZeroUsage(increment)) {
      continue;
    }

    const timestamp = row.timestamp || lastAt || firstAt;
    const timestampMs = Date.parse(timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }
    await onEvent({
      timestampMs,
      sessionId: meta.id,
      sessionTitle: source.codexTitles?.get(meta.id) || "",
      homeId: source.homeId || source.id,
      homeLabel: source.homeLabel || source.label,
      homePath: source.homePath || source.path,
      channel: classifyCodexChannel({
        originator: meta.originator,
        source: meta.source,
        homeLabel: source.homeLabel || source.label,
      }),
      project: normalizeProjectPath(meta.cwd || source.path),
      model,
      usage: increment,
    });
  }
}

export async function streamUsageFileEvents(filePath, source, onEvent) {
  if (source.provider === "codex") {
    await streamCodexUsageFileEvents(filePath, source, onEvent);
    return;
  }
  await streamClaudeUsageFileEvents(filePath, source, onEvent);
}

export async function parseCodexSessionFile(filePath, source) {
  const meta = {
    id: codexSessionIdFromFilePath(filePath),
    source: "",
    originator: "",
    cwd: "",
    cliVersion: "",
    modelProvider: "",
    title: "",
  };
  let model = "";
  let firstAt = "";
  let lastAt = "";
  let previousCumulative = emptyUsage();
  let finalUsage = emptyUsage();
  let tokenEventCount = 0;
  const events = [];

  for await (const row of readJsonlRows(filePath)) {
    if (row.timestamp) {
      firstAt ||= row.timestamp;
      lastAt = row.timestamp;
    }

    if (row.type === "session_meta") {
      meta.id = row.payload?.id || meta.id;
      meta.source = row.payload?.source || meta.source;
      meta.originator = row.payload?.originator || meta.originator;
      meta.cwd = row.payload?.cwd || meta.cwd;
      meta.cliVersion = row.payload?.cli_version || meta.cliVersion;
      meta.modelProvider = row.payload?.model_provider || meta.modelProvider;
      continue;
    }

    if (row.type === "turn_context") {
      model = row.payload?.model || model;
      continue;
    }

    if (row.type !== "event_msg" || row.payload?.type !== "token_count") {
      continue;
    }

    const { cumulative, last } = readCodexTokenUsage(row.payload);
    let increment = emptyUsage();
    if (cumulative) {
      increment = diffUsage(cumulative, previousCumulative);
      previousCumulative = cumulative;
      finalUsage = cumulative;
    } else if (last) {
      increment = last;
      addUsage(finalUsage, last);
    }

    if (isZeroUsage(increment)) {
      continue;
    }

    tokenEventCount += 1;
    const channel = classifyCodexChannel({
      originator: meta.originator,
      source: meta.source,
      homeLabel: source.homeLabel || source.label,
    });
    events.push({
      id: `${meta.id}:${tokenEventCount}`,
      sessionId: meta.id,
      timestamp: row.timestamp || lastAt || firstAt,
      homeId: source.homeId || source.id,
      homeLabel: source.homeLabel || source.label,
      homePath: source.homePath || source.path,
      channel,
      source: meta.source,
      originator: meta.originator,
      cwd: normalizeProjectPath(meta.cwd),
      model,
      provider: "codex",
      total: increment,
    });
  }

  if (!events.length) {
    return null;
  }

  const channel = classifyCodexChannel({
    originator: meta.originator,
    source: meta.source,
    homeLabel: source.homeLabel || source.label,
  });

  return {
    session: {
      id: meta.id,
      title: source.codexTitles?.get(meta.id) || "",
      filePath,
      firstAt,
      lastAt,
      homeId: source.homeId || source.id,
      homeLabel: source.homeLabel || source.label,
      homePath: source.homePath || source.path,
      channel,
      source: meta.source,
      originator: meta.originator,
      cwd: normalizeProjectPath(meta.cwd),
      model,
      cliVersion: meta.cliVersion,
      modelProvider: meta.modelProvider,
      provider: "codex",
      eventCount: events.length,
      total: finalUsage,
    },
    events,
  };
}

async function parseSourceSessionFileForIndex(filePath, source, intern) {
  const events = [];
  await streamUsageFileEvents(filePath, source, (event) => {
    events.push({
      t: event.timestampMs,
      s: intern(event.sessionId),
      n: intern(event.sessionTitle || ""),
      h: intern(event.homeId),
      l: intern(event.homeLabel),
      c: intern(event.channel),
      p: intern(event.project),
      m: intern(event.model),
      v: intern(source.provider),
      total: event.usage.total,
      input: event.usage.input,
      cached: event.usage.cached,
      output: event.usage.output,
      reasoning: event.usage.reasoning,
    });
  });
  return events;
}

async function parseSourceSessionFile(filePath, source) {
  // Claude and Codex sessions have unrelated JSONL schemas; dispatch by provider.
  if (source.provider === "codex") {
    return parseCodexSessionFile(filePath, source);
  }
  return parseClaudeSessionFile(filePath, source);
}

export async function buildUsageReport(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const sessions = [];
  const events = [];
  const warnings = [];

  for (const home of homes) {
    let files = [];
    try {
      files = await discoverSourceSessionFiles(home);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        const parsed = await parseSourceSessionFile(file, home);
        if (!parsed) {
          continue;
        }
        sessions.push(parsed.session);
        events.push(...parsed.events);
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  sessions.sort((a, b) => String(a.lastAt).localeCompare(String(b.lastAt)));

  return {
    generatedAt: new Date().toISOString(),
    homes,
    sessions,
    events,
    warnings,
  };
}

export async function buildUsageIndex(options = {}) {
  const homes = options.homes || (await discoverUsageSources(options));
  const warnings = [];
  const events = [];
  const interner = createStringInterner();

  for (const home of homes) {
    let files = [];
    try {
      files = await discoverSourceSessionFiles(home);
    } catch (error) {
      warnings.push(`无法读取 ${home.path}: ${error.message}`);
      continue;
    }

    for (const file of files) {
      try {
        events.push(...(await parseSourceSessionFileForIndex(file, home, interner.intern)));
      } catch (error) {
        warnings.push(`无法解析 ${file}: ${error.message}`);
      }
    }
  }

  events.sort((a, b) => a.t - b.t);

  return {
    generatedAt: new Date().toISOString(),
    homes,
    warnings,
    strings: interner.values,
    events,
    sessionCount: new Set(events.map((event) => event.s)).size,
  };
}

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthKey(date) {
  return localDateKey(date).slice(0, 7);
}

function localHourKey(date) {
  // Hour buckets stay in local time so API summaries match the browser dashboard labels.
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function startOfLocalHour(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours());
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSingleLocalDayRange(range = {}) {
  // Single-day hourly summaries should include zero-use hours for a complete 24-hour chart.
  return Boolean(range.start && range.end && localDateKey(range.start) === localDateKey(range.end));
}

function endOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfLocalWeek(date) {
  const start = startOfLocalDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addLocalHours(date, hours) {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function parseDateStart(value) {
  return value ? new Date(`${value}T00:00:00`) : null;
}

function parseDateEnd(value) {
  return value ? new Date(`${value}T23:59:59.999`) : null;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractMonthsClamped(date, months) {
  const target = new Date(date.getFullYear(), date.getMonth() - months, 1);
  const day = Math.min(date.getDate(), daysInMonth(target.getFullYear(), target.getMonth()));
  return new Date(
    target.getFullYear(),
    target.getMonth(),
    day,
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  );
}

function parseRecentValue(value) {
  const normalized = String(value || "").trim().replace(/\s+/g, "");
  if (normalized === "半年") {
    return { months: 6 };
  }
  if (normalized === "一年") {
    return { months: 12 };
  }
  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) {
    return { days: Number(dayMatch[1]) };
  }
  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) {
    return { days: Number(weekMatch[1]) * 7 };
  }
  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) {
    return { months: Number(monthMatch[1]) };
  }
  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) {
    return { months: Number(yearMatch[1]) * 12 };
  }
  return null;
}

function recentDateRange(value, now) {
  const parsed = parseRecentValue(value);
  if (!parsed) {
    return null;
  }
  if (parsed.days === 1) {
    return {
      start: new Date(now.getTime() - MS_PER_DAY),
      end: now,
      preset: "recent",
      rolling: true,
    };
  }
  const start = parsed.days
    ? addLocalDays(startOfLocalDay(now), 1 - parsed.days)
    : startOfLocalDay(subtractMonthsClamped(now, parsed.months));
  return {
    start,
    end: endOfLocalDay(now),
    preset: "recent",
  };
}

export function resolveDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite),
  );
}

function resolveDateRangeFromTimestamps(filters = {}, timestamps = []) {
  // Report and index summaries share this resolver to avoid date-range drift.
  const now = filters.now ? new Date(filters.now) : new Date();
  const preset = filters.preset || "all";
  if (preset === "today") {
    return { start: startOfLocalDay(now), end: endOfLocalDay(now), preset };
  }
  if (preset === "week") {
    return { start: startOfLocalWeek(now), end: endOfLocalDay(now), preset };
  }
  if (preset === "month") {
    return {
      start: new Date(now.getFullYear(), now.getMonth(), 1),
      end: endOfLocalDay(now),
      preset,
    };
  }
  if (preset === "custom") {
    return {
      start: parseDateStart(filters.startDate),
      end: parseDateEnd(filters.endDate),
      preset,
    };
  }
  if (preset === "recent") {
    const range = recentDateRange(filters.recentValue, now);
    if (range) {
      return range;
    }
  }

  if (!timestamps.length) {
    return { start: null, end: null, preset: "all" };
  }
  let earliestTimestamp = timestamps[0];
  let latestTimestamp = timestamps[0];
  for (const timestamp of timestamps) {
    if (timestamp < earliestTimestamp) {
      earliestTimestamp = timestamp;
    }
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }
  return {
    start: startOfLocalDay(new Date(earliestTimestamp)),
    end: endOfLocalDay(new Date(latestTimestamp)),
    preset: "all",
  };
}

function bucketKey(date, bucket) {
  if (bucket === "hour") {
    return localHourKey(date);
  }
  if (bucket === "month") {
    return monthKey(date);
  }
  if (bucket === "week") {
    return localDateKey(startOfLocalWeek(date));
  }
  return localDateKey(date);
}

function groupByUsage(events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
      modelGroups: options.includeModels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(event.sessionId);
    addUsage(current.total, event.total);
    if (current.channelGroups) {
      const channelKey = event.channel || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.sessionId);
      addUsage(channel.total, event.total);
      current.channelGroups.set(channelKey, channel);
    }
    if (current.modelGroups) {
      const modelKey = event.model || "Unknown model";
      const model = current.modelGroups.get(modelKey) || {
        key: modelKey,
        name: modelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      model.count += 1;
      model.sessions.add(event.sessionId);
      addUsage(model.total, event.total);
      current.modelGroups.set(modelKey, model);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
      ...(group.channelGroups
        ? {
            channels: [...group.channelGroups.values()]
              .map((channel) => ({
                key: channel.key,
                name: channel.name,
                count: channel.count,
                sessions: channel.sessions.size,
                total: channel.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
      ...(group.modelGroups
        ? {
            models: [...group.modelGroups.values()]
              .map((model) => ({
                key: model.key,
                name: model.name,
                count: model.count,
                sessions: model.sessions.size,
                total: model.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

function indexDateRange(filters = {}, events = []) {
  return resolveDateRangeFromTimestamps(
    filters,
    events.map((event) => event.t).filter(Number.isFinite),
  );
}

function addIndexedUsage(target, event) {
  for (const field of USAGE_FIELDS) {
    target[field] += event[field] || 0;
  }
  return target;
}

function groupIndexedEvents(index, events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event) || "Unknown";
    const current = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
      modelGroups: options.includeModels ? new Map() : null,
    };
    current.count += 1;
    current.sessions.add(event.s);
    addIndexedUsage(current.total, event);
    if (current.channelGroups) {
      const channelKey = index.strings[event.c] || "Unknown";
      const channel = current.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.s);
      addIndexedUsage(channel.total, event);
      current.channelGroups.set(channelKey, channel);
    }
    if (current.modelGroups) {
      const modelKey = index.strings[event.m] || "Unknown model";
      const model = current.modelGroups.get(modelKey) || {
        key: modelKey,
        name: modelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      model.count += 1;
      model.sessions.add(event.s);
      addIndexedUsage(model.total, event);
      current.modelGroups.set(modelKey, model);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
      ...(group.channelGroups
        ? {
            channels: [...group.channelGroups.values()]
              .map((channel) => ({
                key: channel.key,
                name: channel.name,
                count: channel.count,
                sessions: channel.sessions.size,
                total: channel.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
      ...(group.modelGroups
        ? {
            models: [...group.modelGroups.values()]
              .map((model) => ({
                key: model.key,
                name: model.name,
                count: model.count,
                sessions: model.sessions.size,
                total: model.total,
              }))
              .sort((a, b) => b.total.total - a.total.total),
          }
        : {}),
    }))
    .sort((a, b) => b.total.total - a.total.total);
}

function emptyTimelineRow(key) {
  // Empty timeline rows preserve the same response shape as grouped hourly rows.
  return {
    key,
    name: key,
    count: 0,
    sessions: 0,
    total: emptyUsage(),
    channels: [],
  };
}

export function completeHourlyTimeline(rows, range, bucket) {
  // 最近范围按选定边界补齐小时；普通单日范围保留完整自然日补齐。
  if (bucket !== "hour" || (!isSingleLocalDayRange(range) && range?.preset !== "recent")) {
    return rows;
  }
  const rowsByKey = new Map(rows.map((row) => [row.key, row]));
  const start = range?.preset === "recent" ? startOfLocalHour(range.start) : startOfLocalDay(range.start);
  const end = range?.preset === "recent" ? startOfLocalHour(range.end) : addLocalHours(start, 23);
  const hourCount = Math.max(0, Math.round((end.getTime() - start.getTime()) / MS_PER_HOUR) + 1);
  return Array.from({ length: hourCount }, (_, hour) => {
    const bucketStart = addLocalHours(start, hour);
    const key = localHourKey(bucketStart);
    return rowsByKey.get(key) || emptyTimelineRow(key);
  });
}

export function usageIndexMetadata(index) {
  const homeStats = homeStatsFromIndex(index);
  return {
    generatedAt: index.generatedAt,
    eventCount: index.events.length,
    sessionCount: index.sessionCount,
    homeCount: index.homes.length,
    homes: index.homes.map((home) => ({
      ...home,
      ...(homeStats.get(home.id) || {
        status: "no-events",
        eventCount: 0,
        sessionCount: 0,
      }),
    })),
    warnings: index.warnings,
  };
}

function homeStatsFromIndex(index) {
  // Attach per-home activity counts without expanding the compact index into full events.
  const stats = new Map();
  for (const event of index.events) {
    const homeId = index.strings[event.h] || "";
    const current = stats.get(homeId) || {
      status: "active",
      eventCount: 0,
      sessions: new Set(),
    };
    current.eventCount += 1;
    current.sessions.add(event.s);
    stats.set(homeId, current);
  }
  return new Map(
    [...stats.entries()].map(([homeId, stat]) => [
      homeId,
      {
        status: stat.eventCount > 0 ? "active" : "no-events",
        eventCount: stat.eventCount,
        sessionCount: stat.sessions.size,
      },
    ]),
  );
}

export function previousUsageRange(range) {
  if (!range.start || !range.end || range.preset === "all") {
    return null;
  }
  if (range.preset === "today") {
    const previousDay = addLocalDays(startOfLocalDay(range.start), -1);
    return {
      start: previousDay,
      end: endOfLocalDay(previousDay),
    };
  }
  if (range.preset === "week") {
    const previousWeekStart = addLocalDays(startOfLocalWeek(range.start), -7);
    return {
      start: previousWeekStart,
      end: endOfLocalDay(addLocalDays(previousWeekStart, 6)),
    };
  }
  if (range.preset === "month") {
    const currentMonthStart = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
    return {
      start: new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: endOfLocalDay(new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 0)),
    };
  }
  const durationMs = range.end.getTime() - range.start.getTime() + 1;
  return {
    start: new Date(range.start.getTime() - durationMs),
    end: new Date(range.start.getTime() - 1),
  };
}

function rangeDurationMs(range) {
  if (!range?.start || !range?.end) {
    return 0;
  }
  return Math.max(0, range.end.getTime() - range.start.getTime() + 1);
}

function currentElapsedMs(range, now) {
  if (!range?.start || !range?.end || Number.isNaN(now?.getTime())) {
    return rangeDurationMs(range);
  }
  const boundedEnd = Math.min(range.end.getTime(), Math.max(range.start.getTime(), now.getTime()));
  return Math.max(0, boundedEnd - range.start.getTime() + 1);
}

function averageTrend(currentTotals, previousTotals, range, previousRange, now) {
  const previousDurationMs = rangeDurationMs(previousRange);
  const elapsedMs = currentElapsedMs(range, now);
  const averageBaselineTotal = previousDurationMs
    ? Math.round((previousTotals.total * elapsedMs) / previousDurationMs)
    : 0;
  return {
    averageBaselineTotal,
    averageDelta: currentTotals.total - averageBaselineTotal,
    averagePercentChange: percentChange(currentTotals.total, averageBaselineTotal),
  };
}

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function comparisonLabel(preset) {
  return {
    today: "较昨日",
    week: "较上周",
    month: "较上月",
    custom: "较上一等长周期",
    recent: "较上一等长周期",
  }[preset] || "暂无对比";
}

function usageComparison({ range, allEvents, eventTime, eventSession, addEventUsage, currentTotals, now }) {
  // 保持调用方事件结构不变，只在这里统一计算上一周期和趋势。
  const previousRange = previousUsageRange(range);
  if (!previousRange) {
    return usageComparisonFromAggregates({ range, currentTotals, now });
  }
  const previousEvents = allEvents.filter((event) => {
    const time = eventTime(event);
    return Number.isFinite(time) && time >= previousRange.start.getTime() && time <= previousRange.end.getTime();
  });
  const previousTotals = previousEvents.reduce((sum, event) => addEventUsage(sum, event), emptyUsage());
  const previousSessions = new Set(previousEvents.map(eventSession));
  return usageComparisonFromAggregates({
    range,
    currentTotals,
    previousTotals,
    previousEventCount: previousEvents.length,
    previousSessionCount: previousSessions.size,
    now,
  });
}

export function usageComparisonFromAggregates({
  range,
  currentTotals,
  previousTotals = emptyUsage(),
  previousEventCount = 0,
  previousSessionCount = 0,
  now,
}) {
  const previousRange = previousUsageRange(range);
  if (!previousRange) {
    return {
      label: comparisonLabel(range.preset),
      previousRange: null,
      previousTotals: emptyUsage(),
      previousEventCount: 0,
      previousSessionCount: 0,
      totalDelta: currentTotals.total,
      percentChange: null,
      averageBaselineTotal: 0,
      averageDelta: currentTotals.total,
      averagePercentChange: null,
    };
  }
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);

  return {
    label: comparisonLabel(range.preset),
    previousRange: {
      start: previousRange.start.toISOString(),
      end: previousRange.end.toISOString(),
    },
    previousTotals,
    previousEventCount,
    previousSessionCount,
    totalDelta: currentTotals.total - previousTotals.total,
    percentChange: percentChange(currentTotals.total, previousTotals.total),
    ...average,
  };
}

function sessionGroupsFromEvents(events) {
  // Build per-session summaries from full report events for non-indexed scenarios.
  const sessions = new Map();
  for (const event of events) {
    const key = event.sessionId || "";
    const current = sessions.get(key) || {
      key,
      name: "",
      count: 0,
      title: event.sessionTitle || "",
      project: event.cwd || "",
      total: emptyUsage(),
      firstAt: Infinity,
      lastAt: -Infinity,
    };
    current.count += 1;
    current.title = current.title || event.sessionTitle || "";
    current.project = current.project || event.cwd || "";
    addUsage(current.total, event.total);
    const t = Date.parse(event.timestamp);
    if (Number.isFinite(t)) {
      if (t < current.firstAt) current.firstAt = t;
      if (t > current.lastAt) current.lastAt = t;
    }
    sessions.set(key, current);
  }
  return [...sessions.values()]
    .map((s) => {
      const name =
        s.title ||
        `${s.project || "Unknown"} ${s.firstAt < Infinity ? localDateKey(new Date(s.firstAt)) : ""}`;
      return {
        key: s.key,
        name,
        title: s.title,
        project: s.project,
        count: s.count,
        total: s.total,
        firstAt: s.firstAt < Infinity ? new Date(s.firstAt).toISOString() : "",
        lastAt: s.lastAt > -Infinity ? new Date(s.lastAt).toISOString() : "",
      };
    })
    .sort((a, b) => (b.lastAt || "").localeCompare(a.lastAt || "") || b.total.total - a.total.total);
}

function sessionGroupsFromIndex(index, events) {
  const strings = index.strings;
  const sessions = new Map();
  for (const event of events) {
    const key = strings[event.s] || "";
    const current = sessions.get(key) || {
      key,
      name: "",
      count: 0,
      title: strings[event.n] || "",
      project: strings[event.p] || "",
      total: emptyUsage(),
      firstAt: Infinity,
      lastAt: -Infinity,
    };
    current.count += 1;
    current.title = current.title || strings[event.n] || "";
    current.project = current.project || strings[event.p] || "";
    addIndexedUsage(current.total, event);
    if (event.t < current.firstAt) current.firstAt = event.t;
    if (event.t > current.lastAt) current.lastAt = event.t;
    sessions.set(key, current);
  }
  return [...sessions.values()]
    .map((s) => {
      const name =
        s.title ||
        `${s.project || "Unknown"} ${localDateKey(new Date(s.firstAt))}`;
      return {
        key: s.key,
        name,
        title: s.title,
        project: s.project,
        count: s.count,
        total: s.total,
        firstAt: new Date(s.firstAt).toISOString(),
        lastAt: new Date(s.lastAt).toISOString(),
      };
    })
    .sort((a, b) => (b.lastAt || "").localeCompare(a.lastAt || "") || b.total.total - a.total.total);
}

function providerFilterActive(filters) {
  const provider = filters.provider;
  return provider && provider !== "all";
}

function providerBreakdown(events, getProvider, addUsage) {
  const byProvider = new Map();
  for (const event of events) {
    const provider = getProvider(event) || "unknown";
    const current = byProvider.get(provider) || { provider, totals: emptyUsage() };
    addUsage(current.totals, event);
    byProvider.set(provider, current);
  }
  return [...byProvider.values()]
    .map(({ provider, totals }) => ({ provider, totals }))
    .sort((a, b) => b.totals.total - a.totals.total);
}

export function summarizeUsageIndex(index, filters = {}) {
  const bucket = filters.bucket || "day";
  const strings = index.strings;
  const range = indexDateRange(filters, index.events);
  const now = filters.now ? new Date(filters.now) : new Date();
  const providerFilter = providerFilterActive(filters);
  const allEvents = index.events.filter((event) => {
    if (!Number.isFinite(event.t)) {
      return false;
    }
    if (range.start && event.t < range.start.getTime()) {
      return false;
    }
    if (range.end && event.t > range.end.getTime()) {
      return false;
    }
    return true;
  });
  const events = providerFilter
    ? allEvents.filter((event) => (strings[event.v] || "claude") === filters.provider)
    : allEvents;

  const sessionIds = new Set(events.map((event) => event.s));
  const totals = events.reduce((sum, event) => addIndexedUsage(sum, event), emptyUsage());
  const comparison = usageComparison({
    range,
    allEvents: index.events,
    eventTime: (event) => event.t,
    eventSession: (event) => event.s,
    addEventUsage: addIndexedUsage,
    currentTotals: totals,
    now,
  });
  const timeline = completeHourlyTimeline(
    groupIndexedEvents(index, events, (event) => bucketKey(new Date(event.t), bucket), { includeModels: true }).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    range,
    bucket,
  );

  return {
    generatedAt: index.generatedAt,
    range: {
      preset: range.preset,
      start: range.start ? range.start.toISOString() : null,
      end: range.end ? range.end.toISOString() : null,
      bucket,
      rolling: Boolean(range.rolling),
    },
    totals,
    comparison,
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.h)).size,
    providers: providerBreakdown(allEvents, (event) => strings[event.v] || "claude", addIndexedUsage),
    timeline,
    channels: groupIndexedEvents(index, events, (event) => strings[event.c]),
    homes: groupIndexedEvents(index, events, (event) => strings[event.l]),
    models: groupIndexedEvents(index, events, (event) => strings[event.m] || "Unknown model"),
    projects: groupIndexedEvents(index, events, (event) => strings[event.p] || "Unknown cwd"),
    sessions: sessionGroupsFromIndex(index, events),
  };
}

export function summarizeUsage(report, filters = {}) {
  const bucket = filters.bucket || "day";
  const range = resolveDateRange(filters, report.events);
  const now = filters.now ? new Date(filters.now) : new Date();
  const providerFilter = providerFilterActive(filters);
  const allEvents = report.events.filter((event) => {
    const date = new Date(event.timestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    if (range.start && date < range.start) {
      return false;
    }
    if (range.end && date > range.end) {
      return false;
    }
    return true;
  });
  const events = providerFilter
    ? allEvents.filter((event) => (event.provider || "claude") === filters.provider)
    : allEvents;

  const sessionIds = new Set(events.map((event) => event.sessionId));
  const totals = events.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const comparison = usageComparison({
    range,
    allEvents: report.events,
    eventTime: (event) => Date.parse(event.timestamp),
    eventSession: (event) => event.sessionId,
    addEventUsage: (sum, event) => addUsage(sum, event.total),
    currentTotals: totals,
    now,
  });
  const timeline = completeHourlyTimeline(
    groupByUsage(events, (event) => bucketKey(new Date(event.timestamp), bucket), { includeModels: true }).sort((a, b) =>
      a.key.localeCompare(b.key),
    ),
    range,
    bucket,
  );

  return {
    generatedAt: report.generatedAt,
    range: {
      preset: range.preset,
      start: range.start ? range.start.toISOString() : null,
      end: range.end ? range.end.toISOString() : null,
      bucket,
      rolling: Boolean(range.rolling),
    },
    totals,
    comparison,
    eventCount: events.length,
    sessionCount: sessionIds.size,
    homeCount: new Set(events.map((event) => event.homeId)).size,
    providers: providerBreakdown(
      allEvents,
      (event) => event.provider || "claude",
      (sum, event) => addUsage(sum, event.total),
    ),
    timeline,
    channels: groupByUsage(events, (event) => event.channel),
    homes: groupByUsage(events, (event) => event.homeLabel),
    models: groupByUsage(events, (event) => event.model || "Unknown model"),
    projects: groupByUsage(events, (event) => event.cwd || "Unknown cwd"),
    sessions: sessionGroupsFromEvents(events),
  };
}
