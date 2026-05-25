import * as crypto from "crypto";
const COMPLETION_SUCCESS = "1";
const COMPLETION_FAILURE = "2";
const TOOL_SUCCESS = "1";
const TOOL_FAILURE = "2";
const PERMISSION = {
    READ_ONLY: "1",
    READ_WRITE: "2",
    PRIVILEGED: "3",
};
// ── ToolHandle ────────────────────────────────────────────────────────────────
export class ToolHandle {
    _step;
    name;
    _args;
    _span = null;
    _start = 0;
    _done = false;
    constructor(_step, name, _args = {}, permission = "READ_ONLY") {
        this._step = _step;
        this.name = name;
        this._args = _args;
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
    success(opts = {}) {
        this._finish(TOOL_SUCCESS, opts.latencyMs);
    }
    fail(opts = {}) {
        this._finish(TOOL_FAILURE, opts.latencyMs, opts.errorCode);
    }
    _finish(status, latencyMs, errorCode) {
        if (this._done || !this._span)
            return;
        this._done = true;
        const elapsed = Date.now() - this._start;
        const attrs = {
            "routeiq.tool.result_status": status,
            "routeiq.tool.latency_ms": latencyMs ?? elapsed,
        };
        if (errorCode)
            attrs["routeiq.tool.error_code"] = errorCode;
        this._span.setAttributes(attrs);
    }
    [Symbol.dispose]() {
        if (!this._done)
            this.success();
        this._span?.end();
    }
}
// ── StepHandle ────────────────────────────────────────────────────────────────
export class StepHandle {
    _task;
    stepId;
    _span = null;
    _done = false;
    constructor(_task, opts = {}) {
        this._task = _task;
        this.stepId = crypto.randomUUID();
        const riq = _task._riq;
        this._span = riq._tracer.startSpan(`step:${this.stepId}`);
        const attrs = {
            "routeiq.event.type": "4",
            ...riq._envelope(_task, this),
            "routeiq.step.index": opts.index ?? 1,
        };
        if (opts.action)
            attrs["routeiq.step.selected_action"] = opts.action;
        if (opts.rationale)
            attrs["routeiq.step.action_rationale"] = opts.rationale;
        this._span.setAttributes(attrs);
    }
    tool(name, args = {}, permission = "READ_ONLY") {
        return new ToolHandle(this, name, args, permission);
    }
    complete() {
        this._finish(COMPLETION_SUCCESS);
    }
    fail(category = "") {
        this._finish(COMPLETION_FAILURE, category);
    }
    _finish(status, failureCategory = "") {
        if (this._done || !this._span)
            return;
        this._done = true;
        const attrs = { "routeiq.step.completion_status": status };
        if (failureCategory)
            attrs["routeiq.step.failure_category"] = failureCategory;
        this._span.setAttributes(attrs);
    }
    [Symbol.dispose]() {
        if (!this._done)
            this.complete();
        this._span?.end();
    }
}
// ── TaskHandle ────────────────────────────────────────────────────────────────
export class TaskHandle {
    _riq;
    intent;
    taskType;
    taskId;
    runId;
    _span = null;
    _done = false;
    _stepIndex = 0;
    constructor(_riq, intent, taskType) {
        this._riq = _riq;
        this.intent = intent;
        this.taskType = taskType;
        this.taskId = crypto.randomUUID();
        this.runId = crypto.randomUUID();
        this._span = _riq._tracer.startSpan(`task:${this.taskId}`);
        const attrs = {
            "routeiq.event.type": "1",
            ..._riq._envelope(this),
            "routeiq.task.input_intent": intent.slice(0, 256),
        };
        if (taskType)
            attrs["routeiq.task.type"] = taskType;
        this._span.setAttributes(attrs);
    }
    step(opts = {}) {
        this._stepIndex += 1;
        return new StepHandle(this, { ...opts, index: this._stepIndex });
    }
    complete(opts = {}) {
        this._finish(COMPLETION_SUCCESS, opts);
    }
    fail(category = "") {
        this._finish(COMPLETION_FAILURE, { failureCategory: category });
    }
    _finish(status, opts = {}) {
        if (this._done || !this._span)
            return;
        this._done = true;
        const attrs = { "routeiq.task.completion_status": status };
        if (opts.tokens)
            attrs["routeiq.task.total_tokens"] = opts.tokens;
        if (opts.costUsd != null)
            attrs["routeiq.task.cost_usd"] = opts.costUsd;
        if (opts.cohort)
            attrs["routeiq.task.cohort"] = opts.cohort;
        if (opts.failureCategory)
            attrs["routeiq.task.failure_category"] = opts.failureCategory;
        this._span.setAttributes(attrs);
    }
    [Symbol.dispose]() {
        if (!this._done)
            this.complete();
        this._span?.end();
    }
}
