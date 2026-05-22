import type { Span, Tracer } from "@opentelemetry/api";
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

export interface Envelope {
  "routeiq.agent.id": string;
  "routeiq.tenant.id": string;
  "routeiq.environment": string;
  "routeiq.session.id": string;
  "routeiq.task.id"?: string;
  "routeiq.run.id"?: string;
  "routeiq.step.id"?: string;
  "routeiq.version.model.name"?: string;
  "routeiq.version.agent"?: string;
}

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
  }

  success(opts: { latencyMs?: number } = {}): void {
    this._finish(TOOL_SUCCESS, opts.latencyMs);
  }

  fail(opts: { errorCode?: string; latencyMs?: number } = {}): void {
    this._finish(TOOL_FAILURE, opts.latencyMs, opts.errorCode);
  }

  private _finish(status: string, latencyMs?: number, errorCode?: string): void {
    if (this._done || !this._span) return;
    this._done = true;
    const elapsed = Date.now() - this._start;
    const attrs: Record<string, string | number> = {
      "routeiq.tool.result_status": status,
      "routeiq.tool.latency_ms": latencyMs ?? elapsed,
    };
    if (errorCode) attrs["routeiq.tool.error_code"] = errorCode;
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
    opts: { action?: string; rationale?: string; index?: number } = {},
  ) {
    this.stepId = crypto.randomUUID();
    const riq = _task._riq;
    this._span = riq._tracer.startSpan(`step:${this.stepId}`);
    const attrs: Record<string, string | number> = {
      "routeiq.event.type": "4",
      ...riq._envelope(_task, this),
      "routeiq.step.index": opts.index ?? 1,
    };
    if (opts.action) attrs["routeiq.step.selected_action"] = opts.action;
    if (opts.rationale) attrs["routeiq.step.action_rationale"] = opts.rationale;
    this._span.setAttributes(attrs);
  }

  tool(name: string, args: Record<string, unknown> = {}, permission = "READ_ONLY"): ToolHandle {
    return new ToolHandle(this, name, args, permission);
  }

  complete(): void {
    this._finish(COMPLETION_SUCCESS);
  }

  fail(category = ""): void {
    this._finish(COMPLETION_FAILURE, category);
  }

  private _finish(status: string, failureCategory = ""): void {
    if (this._done || !this._span) return;
    this._done = true;
    const attrs: Record<string, string> = { "routeiq.step.completion_status": status };
    if (failureCategory) attrs["routeiq.step.failure_category"] = failureCategory;
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
      ..._riq._envelope(this),
      "routeiq.task.input_intent": intent.slice(0, 256),
    };
    if (taskType) attrs["routeiq.task.type"] = taskType;
    this._span.setAttributes(attrs);
  }

  step(opts: { action?: string; rationale?: string } = {}): StepHandle {
    this._stepIndex += 1;
    return new StepHandle(this, { ...opts, index: this._stepIndex });
  }

  complete(opts: { tokens?: number; costUsd?: number; cohort?: string } = {}): void {
    this._finish(COMPLETION_SUCCESS, opts);
  }

  fail(category = ""): void {
    this._finish(COMPLETION_FAILURE, { failureCategory: category });
  }

  private _finish(
    status: string,
    opts: { tokens?: number; costUsd?: number; cohort?: string; failureCategory?: string } = {},
  ): void {
    if (this._done || !this._span) return;
    this._done = true;
    const attrs: Record<string, string | number> = { "routeiq.task.completion_status": status };
    if (opts.tokens) attrs["routeiq.task.total_tokens"] = opts.tokens;
    if (opts.costUsd != null) attrs["routeiq.task.cost_usd"] = opts.costUsd;
    if (opts.cohort) attrs["routeiq.task.cohort"] = opts.cohort;
    if (opts.failureCategory) attrs["routeiq.task.failure_category"] = opts.failureCategory;
    this._span.setAttributes(attrs);
  }

  [Symbol.dispose](): void {
    if (!this._done) this.complete();
    this._span?.end();
  }
}
