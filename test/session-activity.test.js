import assert from "node:assert/strict";
import test from "node:test";
import { SessionActivity } from "../src/session-activity.js";

const timestamp = "2026-09-28T12:00:00Z";

function codex(activity, type, payload) {
  activity.observe({ type, timestamp, payload });
}

test("Codex waits for explicit input and resumes when the matching answer arrives", () => {
  const activity = new SessionActivity("codex");
  codex(activity, "event_msg", { type: "task_started" });
  assert.equal(activity.status, "active");
  codex(activity, "response_item", { type: "function_call", name: "functions.request_user_input", call_id: "question" });
  assert.equal(activity.status, "waiting");
  codex(activity, "event_msg", { type: "token_count" });
  codex(activity, "response_item", { type: "function_call_output", call_id: "other" });
  assert.equal(activity.status, "waiting");
  codex(activity, "response_item", { type: "function_call_output", call_id: "question" });
  assert.equal(activity.status, "active");
  codex(activity, "event_msg", { type: "task_complete", last_agent_message: "Done." });
  assert.equal(activity.status, "completed");
  codex(activity, "event_msg", { type: "token_count" });
  codex(activity, "event_msg", { type: "thread_settings_applied" });
  assert.equal(activity.status, "completed");
});

test("async question acknowledgement does not mean the user has answered", () => {
  for (const call of [
    { type: "function_call", name: "functions.request_user_input_async", call_id: "question" },
    { type: "custom_tool_call", name: "exec", call_id: "question", input: 'await tools.request_user_input_async({ questions: [{title: "Choose an option"}] });' },
  ]) {
    const activity = new SessionActivity("codex");
    codex(activity, "response_item", call);
    codex(activity, "response_item", { type: "custom_tool_call_output", call_id: "question" });
    codex(activity, "event_msg", { type: "task_complete", last_agent_message: "Waiting for your selection." });
    assert.equal(activity.status, "waiting");
    codex(activity, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "First option." }] });
    assert.equal(activity.status, "active");
  }
});

test("final questions wait for input and ordinary final answers complete", () => {
  for (const [text, expected] of [
    ["请选择一个方案。", "waiting"],
    ["需要继续部署吗？", "waiting"],
    ["Please confirm before I deploy.", "waiting"],
    ["Done. All checks passed.", "completed"],
    ["修改已完成。如果需要，可以继续问我。", "completed"],
  ]) {
    const activity = new SessionActivity("codex");
    codex(activity, "response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] });
    assert.equal(activity.status, expected, text);
    codex(activity, "event_msg", { type: "task_complete" });
    assert.equal(activity.status, expected, text);
    codex(activity, "event_msg", { type: "task_started" });
    assert.equal(activity.status, "active");
  }
});

test("interrupted and failed turns are not reported as successfully completed", () => {
  for (const [payload, expected] of [
    [{ type: "turn_aborted", reason: "interrupted" }, "interrupted"],
    [{ type: "turn_aborted", reason: "quota_exceeded" }, "failed"],
    [{ type: "task_complete", error: "failed" }, "failed"],
  ]) {
    const activity = new SessionActivity("codex");
    codex(activity, "event_msg", { type: "task_started" });
    codex(activity, "event_msg", payload);
    assert.equal(activity.status, expected);
  }
});

test("Codex quota and other terminal errors remain failed until execution resumes", () => {
  for (const payload of [
    { type: "task_complete", error: { codex_error_info: "rate_limit_exceeded", message: "Usage limit reached" } },
    { type: "task_complete", error: { codex_error_info: "other", message: "Connection closed" } },
    { type: "error", codex_error_info: "usage_limit_reached" },
    { type: "stream_error", will_retry: false, message: "Retries exhausted" },
  ]) {
    const activity = new SessionActivity("codex");
    codex(activity, "event_msg", { type: "task_started" });
    codex(activity, "response_item", { type: "function_call", name: "request_user_input", call_id: "question" });
    codex(activity, "event_msg", payload);
    assert.equal(activity.status, "failed");
    codex(activity, "event_msg", { type: "token_count" });
    codex(activity, "event_msg", { type: "task_complete", last_agent_message: "An earlier answer." });
    assert.equal(activity.status, "failed");
    codex(activity, "event_msg", { type: "task_started" });
    assert.equal(activity.status, "active");
    codex(activity, "event_msg", { type: "task_complete", last_agent_message: "Done." });
    assert.equal(activity.status, "completed");
  }
});

test("Codex retry notifications and tool failures do not imply a failed conversation", () => {
  const activity = new SessionActivity("codex");
  codex(activity, "event_msg", { type: "stream_error", will_retry: true, message: "Reconnecting" });
  assert.equal(activity.status, "active");
  codex(activity, "response_item", { type: "function_call_output", call_id: "test", output: "Error: test failed" });
  assert.equal(activity.status, "active");
  codex(activity, "response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "已修复额度耗尽错误的处理逻辑。" }] });
  assert.equal(activity.status, "completed");
});

test("Claude synthetic API errors mark quota exhaustion and server failures", () => {
  for (const error of ["rate_limit", "insufficient_quota", "server_error", "model_not_found", "unknown"]) {
    const activity = new SessionActivity("claude");
    activity.observe({ type: "assistant", timestamp, isApiErrorMessage: true, error, message: {
      model: "<synthetic>", stop_reason: "end_turn", content: [{ type: "text", text: "API Error" }],
    } });
    assert.equal(activity.status, "failed", error);
    activity.observe({ type: "cost-state", timestamp });
    assert.equal(activity.status, "failed");
    activity.observe({ type: "assistant", timestamp, message: {
      model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: "Recovered and completed." }],
    } });
    assert.equal(activity.status, "completed");
  }
});

test("Claude scheduled retries remain active and exhausted retries fail", () => {
  const activity = new SessionActivity("claude");
  activity.observe({ type: "system", subtype: "api_error", timestamp, error: { status: 503 }, retryAttempt: 1, maxRetries: 10, retryInMs: 500 });
  assert.equal(activity.status, "active");
  activity.observe({ type: "system", subtype: "api_error", timestamp, error: { status: 503 }, retryAttempt: 10, maxRetries: 10, retryInMs: 1000 });
  assert.equal(activity.status, "active");
  activity.observe({ type: "system", subtype: "api_error", timestamp, error: { status: 503 }, retryAttempt: 10, maxRetries: 10, retryInMs: 0 });
  assert.equal(activity.status, "failed");
  activity.observe({ type: "user", timestamp, message: { content: "Try again." } });
  assert.equal(activity.status, "active");
});

test("Claude distinguishes questions, tool results, and end-of-turn messages", () => {
  const activity = new SessionActivity("claude");
  activity.observe({ type: "assistant", timestamp, message: {
    model: "test-model", stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "AskUserQuestion", id: "question" }],
  } });
  assert.equal(activity.status, "waiting");
  activity.observe({ type: "user", timestamp, message: {
    content: [{ type: "tool_result", tool_use_id: "other" }],
  } });
  assert.equal(activity.status, "waiting");
  activity.observe({ type: "user", timestamp, message: {
    content: [{ type: "tool_result", tool_use_id: "question" }],
  } });
  assert.equal(activity.status, "active");
  activity.observe({ type: "assistant", timestamp, message: {
    model: "test-model", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }],
  } });
  assert.equal(activity.status, "completed");
  activity.observe({ type: "cost-state", timestamp: "2026-09-28T13:00:00Z" });
  assert.equal(activity.status, "completed");
  assert.equal(activity.lastActivityMs, Date.parse(timestamp));
});
