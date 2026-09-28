const QUESTION_TOOLS = /(?:^|[._])(?:request_user_input(?:_async)?|AskUserQuestion)$/;
const WRAPPED_QUESTION = /\b(?:tools|functions)\.(?:\w*__)?request_user_input(?:_async)?\s*\(/;

function messageText(content) {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content) ? content.map((part) => part.text || "").join("\n") : "";
}

function asksForAnswer(text) {
  const lastParagraph = String(text || "").trim().split(/\n\s*\n/).at(-1) || "";
  return /[?？][\s*_`）)\]】]*$/.test(lastParagraph)
    || /(?:请|需要你|等你|等待你).{0,30}(?:确认|选择|回答|回复|提供|告诉我)|^(?:请问|是否需要|你希望|你想要)|\b(?:please (?:confirm|choose|reply|provide)|let me know|would you like|could you)\b/i.test(lastParagraph);
}

function willRetry(error) {
  const explicit = error.will_retry ?? error.willRetry;
  if (typeof explicit === "boolean") {
    return explicit;
  }
  return Number(error.retryInMs) > 0
    || (Number.isFinite(error.retryAttempt) && Number.isFinite(error.maxRetries) && error.retryAttempt < error.maxRetries);
}

export class SessionActivity {
  constructor(provider) {
    this.provider = provider;
    this.status = "";
    this.sessionId = "";
    this.title = "";
    this.project = "";
    this.model = "";
    this.firstAtMs = 0;
    this.lastActivityMs = 0;
    this.pendingQuestions = new Map();
  }

  update(status, timestamp) {
    this.status = status;
    const timestampMs = Date.parse(timestamp || "");
    if (Number.isFinite(timestampMs)) {
      this.firstAtMs ||= timestampMs;
      this.lastActivityMs = Math.max(this.lastActivityMs, timestampMs);
    }
  }

  resume(timestamp) {
    this.pendingQuestions.clear();
    this.update("active", timestamp);
  }

  working(timestamp) {
    this.update(this.pendingQuestions.size ? "waiting" : "active", timestamp);
  }

  fail(timestamp) {
    this.pendingQuestions.clear();
    this.update("failed", timestamp);
  }

  finish(text, timestamp) {
    if (["failed", "interrupted"].includes(this.status)) {
      this.update(this.status, timestamp);
      return;
    }
    const waiting = this.pendingQuestions.size || asksForAnswer(text) || (!text && this.status === "waiting");
    this.update(waiting ? "waiting" : "completed", timestamp);
  }

  toolCall(name, callId, input, timestamp) {
    const directQuestion = QUESTION_TOOLS.test(name || "");
    const wrappedQuestion = /(?:^|[._])exec$/.test(name || "") && WRAPPED_QUESTION.test(String(input || ""));
    if (directQuestion || wrappedQuestion) {
      const asynchronous = /request_user_input_async/.test(directQuestion ? name : String(input));
      this.pendingQuestions.set(callId || name, asynchronous);
    }
    this.working(timestamp);
  }

  toolResult(callId, timestamp) {
    if (this.pendingQuestions.has(callId) && !this.pendingQuestions.get(callId)) {
      this.pendingQuestions.delete(callId);
    }
    this.working(timestamp);
  }

  observe(row) {
    if (!row || typeof row !== "object") {
      return;
    }
    if (this.provider === "claude") {
      this.observeClaude(row);
      return;
    }
    const payload = row.payload || {};
    if (row.type === "session_meta") {
      this.sessionId = payload.id || this.sessionId;
      this.project = payload.cwd || this.project;
    } else if (row.type === "turn_context") {
      this.model = payload.model || this.model;
    } else if (row.type === "event_msg") {
      if (payload.type === "task_started" || payload.type === "user_message") {
        this.resume(row.timestamp);
      } else if (payload.type === "task_complete") {
        if (payload.error) {
          this.fail(row.timestamp);
        } else {
          this.finish(payload.last_agent_message, row.timestamp);
        }
      } else if (payload.type === "turn_aborted") {
        this.pendingQuestions.clear();
        const cancelled = !payload.reason || ["interrupted", "replaced", "cancelled", "user_cancelled"].includes(payload.reason);
        this.update(cancelled ? "interrupted" : "failed", row.timestamp);
      } else if (["error", "stream_error"].includes(payload.type)) {
        if (willRetry(payload)) {
          this.working(row.timestamp);
        } else {
          this.fail(row.timestamp);
        }
      }
    } else if (row.type === "response_item") {
      if (payload.type === "message" && payload.role === "user") {
        this.resume(row.timestamp);
      } else if (payload.type === "message" && payload.role === "assistant") {
        this.working(row.timestamp);
        if (["final", "final_answer"].includes(payload.phase)) {
          this.finish(messageText(payload.content), row.timestamp);
        }
      } else if (["function_call", "custom_tool_call"].includes(payload.type)) {
        this.toolCall(payload.name, payload.call_id, payload.arguments || payload.input, row.timestamp);
      } else if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
        this.toolResult(payload.call_id, row.timestamp);
      } else if (payload.type === "reasoning") {
        this.working(row.timestamp);
      }
    }
  }

  observeClaude(row) {
    this.sessionId = row.sessionId || this.sessionId;
    this.project = row.cwd || this.project;
    if (row.type === "ai-title") {
      this.title = row.aiTitle || this.title;
    }
    const message = row.message || {};
    const content = Array.isArray(message.content) ? message.content : [];
    if ((row.type === "assistant" && (row.isApiErrorMessage || row.error || message.error))
      || (row.type === "result" && row.is_error)) {
      this.fail(row.timestamp);
      return;
    }
    if (row.type === "system" && row.subtype === "api_error") {
      if (willRetry(row)) {
        this.working(row.timestamp);
      } else {
        this.fail(row.timestamp);
      }
      return;
    }
    if (row.type === "user") {
      const results = content.filter((part) => part.type === "tool_result");
      if (results.length) {
        for (const result of results) {
          this.toolResult(result.tool_use_id, row.timestamp);
        }
      } else {
        this.resume(row.timestamp);
      }
    } else if (row.type === "assistant" && message.model !== "<synthetic>") {
      this.model = message.model || this.model;
      this.working(row.timestamp);
      const calls = content.filter((part) => part.type === "tool_use");
      if (calls.length) {
        for (const call of calls) {
          this.toolCall(call.name, call.id, "", row.timestamp);
        }
      } else if (["end_turn", "stop_sequence"].includes(message.stop_reason)) {
        this.finish(messageText(message.content), row.timestamp);
      }
    }
  }
}
