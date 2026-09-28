import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";

import { buildUsageFingerprint, buildUsageReport, summarizeUsage } from "./usage-core.js";
import { UsageStore } from "./usage-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const MIN_FULL_DETAIL_HEAP_BYTES = 512 * 1024 * 1024;

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJsonBody(request, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Request body is too large");
    }
    chunks.push(chunk);
  }
  if (!size) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bearerToken(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function requestFilters(url) {
  return {
    preset: url.searchParams.get("preset") || "all",
    bucket: url.searchParams.get("bucket") || "day",
    startDate: url.searchParams.get("startDate") || "",
    endDate: url.searchParams.get("endDate") || "",
    recentValue: url.searchParams.get("recentValue") || "",
    provider: url.searchParams.get("provider") || "all",
  };
}

export function isFullDetailHeapAvailable(heapSizeLimitBytes = v8.getHeapStatistics().heap_size_limit) {
  return heapSizeLimitBytes >= MIN_FULL_DETAIL_HEAP_BYTES;
}

async function serveStatic(requestPath, response) {
  const normalized = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(normalized)}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES.get(path.extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    sendText(response, 404, "Not found");
  }
}

export function createUsageServer(options = {}) {
  const usageStore = new UsageStore(options);
  const remoteToken = options.remoteToken || process.env.TOKEN_USAGE_REMOTE_TOKEN || "";
  let storeStatus = null;
  let syncPromise = null;

  async function metadataForStore() {
    return usageStore.metadata();
  }

  async function loadUsageStore({ force = false, check = true } = {}) {
    if (syncPromise) {
      return syncPromise;
    }
    if (!force && !check && storeStatus) {
      return { ...storeStatus, checkedAt: new Date().toISOString() };
    }
    if (!syncPromise) {
      syncPromise = usageStore
        .sync({ force, options })
        .then((status) => {
          storeStatus = status;
          return status;
        })
        .finally(() => {
          syncPromise = null;
        });
    }
    return syncPromise;
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");

    try {
      if (url.pathname === "/api/status") {
        await usageStore.open();
        const status = await buildUsageFingerprint(options);
        const since = url.searchParams.get("since") || "";
        const fingerprint = usageStore.fingerprintFor(status.fingerprint);
        sendJson(response, 200, {
          fingerprint,
          changed: since ? fingerprint !== since : true,
          checkedAt: status.checkedAt,
        });
        return;
      }

      if (url.pathname === "/api/remote/ingest") {
        if (!remoteToken) {
          sendJson(response, 503, { error: "Remote ingestion is disabled" });
          return;
        }
        if (bearerToken(request) !== remoteToken) {
          sendJson(response, 401, { error: "Invalid remote token" });
          return;
        }
        if (request.method !== "POST") {
          sendText(response, 405, "Method not allowed");
          return;
        }
        const payload = await readJsonBody(request);
        if (!payload || payload.protocolVersion !== 1 || !payload.machine || typeof payload.machine !== "object") {
          sendJson(response, 400, { error: "Unsupported or invalid agent payload" });
          return;
        }
        const result = await usageStore.ingestRemote(payload);
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === "/api/remote/status") {
        await usageStore.open();
        sendJson(response, 200, usageStore.remoteSnapshot());
        return;
      }

      if (url.pathname === "/api/usage") {
        const force = url.searchParams.get("force") === "1";
        const detail = url.searchParams.get("detail");
        if (detail === "full") {
          await usageStore.open();
          if (!isFullDetailHeapAvailable()) {
            sendJson(response, 413, {
              error:
                "Full detail report is disabled in low-memory gateway mode. Restart with token-usage gateway --memory-mb 512, or use npm run export for a static snapshot.",
            });
            return;
          }

          const status = await buildUsageFingerprint(options);
          const report = await buildUsageReport(options);
          sendJson(response, 200, {
            fingerprint: usageStore.fingerprintFor(status.fingerprint),
            checkedAt: status.checkedAt,
            metadata: {
              generatedAt: report.generatedAt,
              eventCount: report.events.length,
              sessionCount: report.sessions.length,
              homeCount: report.homes.length,
              homes: report.homes,
              warnings: report.warnings,
            },
            report,
            summary: summarizeUsage(report, requestFilters(url)),
          });
          return;
        }

        const check = url.searchParams.get("skipCheck") !== "1";
        const usage = await loadUsageStore({ force, check });
        sendJson(response, 200, {
          fingerprint: usageStore.fingerprintFor(usage.fingerprint),
          checkedAt: usage.checkedAt,
          metadata: await metadataForStore(),
          summary: usageStore.summarize(requestFilters(url)),
        });
        return;
      }

      if (url.pathname === "/api/summary") {
        const usage = await loadUsageStore();
        sendJson(response, 200, {
          fingerprint: usageStore.fingerprintFor(usage.fingerprint),
          checkedAt: usage.checkedAt,
          metadata: await metadataForStore(),
          summary: usageStore.summarize(requestFilters(url)),
        });
        return;
      }

      await serveStatic(url.pathname, response);
    } catch (error) {
      sendJson(response, 500, {
        error: error.message,
        stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  });
  server.on("close", () => {
    usageStore.close();
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 3765);
  const host = process.env.HOST || "127.0.0.1";
  const server = createUsageServer();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Token Usage dashboard: http://${host}:${actualPort}`);
  });
}
