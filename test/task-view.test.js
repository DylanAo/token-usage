import assert from "node:assert/strict";
import test from "node:test";
import { recentRemoteTasks, renderRemoteStatus } from "../public/app.js";

test("task window includes the 18-hour boundary and excludes invalid or future activity", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const cutoff = now - 18 * 60 * 60 * 1000;
  const tasks = [
    { title: "boundary", lastSeen: new Date(cutoff).toISOString() },
    { title: "expired", lastSeen: new Date(cutoff - 1).toISOString() },
    { title: "recent", lastSeen: new Date(now).toISOString() },
    { title: "future", lastSeen: new Date(now + 1).toISOString() },
    { title: "invalid", lastSeen: "invalid-date" },
  ];
  assert.deepEqual(recentRemoteTasks(tasks, now).map((task) => task.title), ["recent", "boundary"]);
  assert.deepEqual(recentRemoteTasks(tasks, now + 2).map((task) => task.title), ["future", "recent"]);
  assert.equal(tasks[0].title, "boundary");
});

test("task cards show friendly names, hide old activity and keep counts within the window", (context) => {
  const originalDocument = globalThis.document;
  const elements = new Map();
  globalThis.document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, { innerHTML: "", textContent: "" });
      }
      return elements.get(selector);
    },
  };
  context.after(() => {
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  });
  const now = Date.now();
  const tasks = ["active", "waiting", "completed", "active"].map((status, index) => ({
    machineId: "macbook-pro",
    sessionId: `macbook-pro:codex:session-${index}`,
    status,
    lastSeen: new Date(now - (index === 3 ? 19 * 60 * 60 * 1000 : index * 1000)).toISOString(),
  }));
  renderRemoteStatus({ machines: [{ machineId: "macbook-pro", label: "MacBook Air", status: "online" }], tasks });
  let html = elements.get("#remoteTaskList").innerHTML;
  assert.equal((html.match(/class="remote-row"/g) || []).length, 3);
  assert.ok(html.includes("MacBook Air"));
  assert.ok(!html.includes("macbook-pro"));
  assert.match(elements.get("#remoteTaskCount").textContent, /18.* · 1 /);
  renderRemoteStatus({ machines: [], tasks: [{ ...tasks[0], machineLabel: "Air <personal>" }] });
  html = elements.get("#remoteTaskList").innerHTML;
  assert.ok(html.includes("Air &lt;personal&gt;"));
  assert.ok(!html.includes("macbook-pro"));
  renderRemoteStatus({ machines: [], tasks: [{ ...tasks[0], status: "failed", machineLabel: "MacBook Air" }] });
  html = elements.get("#remoteTaskList").innerHTML;
  assert.ok(html.includes('class="remote-badge failed"'));
  assert.match(html, /Unexpected interruption|意外中断/);
});
