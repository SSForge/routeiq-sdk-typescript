import type { Span } from "@opentelemetry/api";
import * as crypto from "crypto";

const COMPLETION_SUCCESS = "1";
const COMPLETION_FAILURE = "2";
const TOOL_SUCCESS = "1";
const TOOL_FAILURE = "2";

const PERMISSION: Record<string, string> = {
  READ_ONLY: "1",
  READ_WRITE: "2",
  PRIVILEGED: "3",
};

// ── ToolHandle ────────────────────────────────────────────────────────────────

export class ToolHandle implements Disposable {
  private _span: Span | null = null;
  private _start = 0;
  private _done = false;

  constructor(
    private readonly _step: StepHandle,
    readonly name: string,
    private readonly _args: Record<string, unknown> = {},
    permission = "READ_ONLY",
  ) {
    const riq = _step._task._riq;
    this._start = Date.now();
    const argsHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(_args, Object.keys(_args).sort()))
      .digest("hex")
      .slice(0, 16);

    this._span = riq._tracer.startSpan(`tool:${name}`);
    this._span.setAttributes({
      "routeiq.event.type": "7",
      ...riq._envelope(_step._task, _step),
      "routeiq.tool.name": name,
      "routeiq.tool.arguments_hash": argsHash,
      "routeiq.tool.permission_level": PERMISSION[permission] ?? "1",
    });

    // Register with task for same_tool_count tracking
    _step._task._recordTool(name);
  }

  success(opts: { latencyMs?: number; tokensIn?: number; tokensOut?: number } = {}): void {
    this._finish(TOOL_SUCCESS, opts);
  }

  fail(opts: { errorCode?: string; latencyMs?: number; retryCount?: number; tokensIn?: number; tokensOut?: number } = {}): void {
    this._finish(TOOL_FAILURE, opts);
  }

  private _finish(
    status: string,
    opts: { latencyMs?: number; errorCode?: string; retryCount?: number; tokensIn?: number; tokensOut?: number } = {},
  ): void {
    if (this._done || !this._span) return;
    this._done = true;
    const elapsed = Date.now() - this._start;
    const attrs: Record<string, string | number> = {
      "routeiq.tool.result_status": status,
      "routeiq.tool.latency_ms": opts.latencyMs ?? elapsed,
    };
    if (opts.errorCode)              attrs["routeiq.tool.error_code"]  = opts.errorCode;
    if (opts.retryCount != null)     attrs["routeiq.tool.retry_count"] = opts.retryCount;
    if (opts.tokensIn   != null)     attrs["routeiq.tool.tokens_in"]   = opts.tokensIn;
    if (opts.tokensOut  != null)     attrs["routeiq.tool.tokens_out"]  = opts.tokensOut;
    this._span.setAttributes(attrs);
  }

  [Symbol.dispose](): void {
    if (!this._done) this.success();
    this._span?.end();
  }
}

// ── StepHandle ────────────────────────────────────────────────────────────────

export class StepHandle implements Disposable {
  readonly stepId: string;
  private _span: Span | null = null;
  private _done = false;

  constructor(
    readonly _task: TaskHandle,
    opts: { action?: string; rationale?: string; index?: number; model?: string } = {},
  ) {
    this.stepId = crypto.randomUUID();
    const riq = _task._riq;
    this._span = riq._tracer.startSpan(`step:${this.stepId}`);
    const attrs: Record<string, string | number> = {
      "routeiq.event.type": "4",
      ...riq._envelope(_task, this),
      "routeiq.step.index": opts.index ?? 1,
    };
    if (opts.action)    attrs["routeiq.step.selected_action"]   = opts.action;
    if (opts.rationale) attrs["routeiq.step.action_rationale"]  = opts.rationale;
    if (opts.model)     attrs["routeiq.step.model"]             = opts.model;
    this._span.setAttributes(attrs);
  }

  tool(name: string, args: Record<string, unknown> = {}, permission = "READ_ONLY"): ToolHandle {
    return new ToolHandle(this, name, args, permission);
  }

  /**
   * Emit a guardrail check span. Call this whenever a policy/guardrail fires.
   * @param type  - guardrail identifier, e.g. "pii_filter", "content_policy"
   * @param blocked - true if the action was blocked by the guardrail
   */
  guardrail(type: string, blocked: boolean): void {
    const span = this._task._riq._tracer.startSpan(`guardrail:${type}`);
    span.setAttributes({
      "routeiq.event.type": "9",
      ...this._task._riq._envelope(this._task, this),
      "routeiq.guardrail.type":    type,
      "routeiq.guardrail.blocked": String(blocked),
    });
    span.end();
  }

  /**
   * Mark that the agent replanned mid-step (e.g. changed strategy after tool failure).
   */
  replan(reason: string): void {
    this._span?.setAttributes({
      "routeiq.replan.triggered": "true",
      "routeiq.replan.reason": reason.slice(0, 256),
    });
  }

  complete(opts: { tokensIn?: number; tokensOut?: number } = {}): void {
    this._finish(COMPLETION_SUCCESS, opts);
  }

  fail(category = ""): void {
    this._finish(COMPLETION_FAILURE, { failureCategory: category });
  }

  private _finish(
    status: string,
    opts: { tokensIn?: number; tokensOut?: number; failureCategory?: string } = {},
  ): void {
    if (this._done || !this._span) return;
    this._done = true;
    const attrs: Record<string, string | number> = { "routeiq.step.completion_status": status };
    if (opts.failureCategory)    attrs["routeiq.step.failure_category"] = opts.failureCategory;
    if (opts.tokensIn  != null)  attrs["routeiq.step.tokens_in"]        = opts.tokensIn;
    if (opts.tokensOut != null)  attrs["routeiq.step.tokens_out"]       = opts.tokensOut;
    this._span.setAttributes(attrs);
  }

  [Symbol.dispose](): void {
    if (!this._done) this.complete();
    this._span?.end();
  }
}

// ── TaskHandle ────────────────────────────────────────────────────────────────

export class TaskHandle implements Disposable {
  readonly taskId: string;
  readonly runId: string;
  private _span: Span | null = null;
  private _done = false;
  private _stepIndex = 0;
  private _toolSequence: string[] = [];

  constructor(
    readonly _riq: import("./client.js").RouteIQ,
    readonly intent: string,
    readonly taskType?: string,
  ) {
    this.taskId = crypto.randomUUID();
    this.runId = crypto.randomUUID();
    this._span = _riq._tracer.startSpan(`task:${this.taskId}`);
    const attrs: Record<string, string> = {
      "routeiq.event.type": "1",
      ..._riq._envelope(this) as Record<string, string>,
      "routeiq.task.input_intent": intent.slice(0, 256),
    };
    if (taskType) attrs["routeiq.task.type"] = taskType;
    this._span.setAttributes(attrs);
  }

  step(opts: { action?: string; rationale?: string; model?: string } = {}): StepHandle {
    this._stepIndex += 1;
    return new StepHandle(this, { ...opts, index: this._stepIndex });
  }

  /**
   * Emit a human-escalation span. Call when the agent hands off to a human operator.
   */
  escalate(opts: { reason?: string; target?: string } = {}): void {
    const span = this._riq._tracer.startSpan(`escalation:${this.taskId}`);
    span.setAttributes({
      "routeiq.event.type": "8",
      ...this._riq._envelope(this),
      "routeiq.escalation.triggered": "true",
      ...(opts.reason && { "routeiq.escalation.reason": opts.reason.slice(0, 256) }),
      ...(opts.target && { "routeiq.escalation.target": opts.target }),
    });
    span.end();
  }

  /** @internal Called by ToolHandle constructor to track tool call sequence. */
  _recordTool(name: string): void {
    this._toolSequence.push(name);
  }

  complete(opts: { tokens?: number; tokensIn?: number; tokensOut?: number; costUsd?: number; cohort?: string } = {}): void {
    this._finish(COMPLETION_SUCCESS, opts);
  }

  fail(category = ""): void {
    this._finish(COMPLETION_FAILURE, { failureCategory: category });
  }

  private _maxSameToolCount(): number {
    if (this._toolSequence.length === 0) return 0;
    let max = 1, cur = 1;
    for (let i = 1; i < this._toolSequence.length; i++) {
      cur = this._toolSequence[i] === this._toolSequence[i - 1] ? cur + 1 : 1;
      if (cur > max) max = cur;
    }
    return max;
  }

  private _finish(
    status: string,
    opts: { tokens?: number; tokensIn?: number; tokensOut?: number; costUsd?: number; cohort?: string; failureCategory?: string } = {},
  ): void {
    if (this._done || !this._span) return;
    this._done = true;
    const attrs: Record<string, string | number> = { "routeiq.task.completion_status": status };
    // Accept split tokens (preferred) or legacy total
    if (opts.tokensIn  != null) attrs["routeiq.task.tokens_in"]    = opts.tokensIn;
    if (opts.tokensOut != null) attrs["routeiq.task.tokens_out"]   = opts.tokensOut;
    const total = opts.tokens ?? (
      opts.tokensIn != null && opts.tokensOut != null ? opts.tokensIn + opts.tokensOut : undefined
    );
    if (total        != null) attrs["routeiq.task.total_tokens"]  = total;
    if (opts.costUsd != null) attrs["routeiq.task.cost_usd"]      = opts.costUsd;
    if (opts.cohort)          attrs["routeiq.task.cohort"]        = opts.cohort;
    if (opts.failureCategory) attrs["routeiq.task.failure_category"] = opts.failureCategory;
    // Emit max consecutive same-tool count for loop detection
    const sameToolCount = this._maxSameToolCount();
    if (sameToolCount > 1) attrs["routeiq.same_tool_count"] = sameToolCount;
    this._span.setAttributes(attrs);
  }

  [Symbol.dispose](): void {
    if (!this._done) this.complete();
    this._span?.end();
  }
}
