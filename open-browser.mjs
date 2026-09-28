// Opens the dashboard in the default browser.
// If the server is not already running, it starts the server first.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 3765;
const URL = `http://127.0.0.1:${PORT}`;
const QUICK_ATTEMPTS = 4;
const QUICK_DELAY_MS = 300;
const FULL_ATTEMPTS = 30;
const FULL_DELAY_MS = 500;

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));

async function checkServer() {
  try {
    const res = await fetch(`${URL}/api/status`);
    return res.ok;
  } catch {
    return false;
  }
}

function openUrl() {
  // Use ShellExecute (Windows API via start) with no console window.
  spawn("cmd", ["/c", "start", "", URL], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

async function openBrowser() {
  // Quick check: is the server already running?
  for (let i = 0; i < QUICK_ATTEMPTS; i += 1) {
    if (await checkServer()) {
      openUrl();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, QUICK_DELAY_MS));
  }

  // Server not running — start it in the background.
  const server = spawn(process.execPath, [path.join(PROJECT_DIR, "src", "cli.js"), "run"], {
    cwd: PROJECT_DIR,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  server.unref();

  // Poll until the server is ready, then open the browser.
  for (let i = 0; i < FULL_ATTEMPTS; i += 1) {
    if (await checkServer()) {
      openUrl();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, FULL_DELAY_MS));
  }

  process.exit(1);
}

openBrowser();