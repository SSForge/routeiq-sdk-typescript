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
export declare class ToolHandle implements Disposable {
    private readonly _step;
    readonly name: string;
    private readonly _args;
    private _span;
    private _start;
    private _done;
    constructor(_step: StepHandle, name: string, _args?: Record<string, unknown>, permission?: string);
    success(opts?: {
        latencyMs?: number;
    }): void;
    fail(opts?: {
        errorCode?: string;
        latencyMs?: number;
    }): void;
    private _finish;
    [Symbol.dispose](): void;
}
export declare class StepHandle implements Disposable {
    readonly _task: TaskHandle;
    readonly stepId: string;
    private _span;
    private _done;
    constructor(_task: TaskHandle, opts?: {
        action?: string;
        rationale?: string;
        index?: number;
    });
    tool(name: string, args?: Record<string, unknown>, permission?: string): ToolHandle;
    complete(): void;
    fail(category?: string): void;
    private _finish;
    [Symbol.dispose](): void;
}
export declare class TaskHandle implements Disposable {
    readonly _riq: import("./client.js").RouteIQ;
    readonly intent: string;
    readonly taskType?: string | undefined;
    readonly taskId: string;
    readonly runId: string;
    private _span;
    private _done;
    private _stepIndex;
    constructor(_riq: import("./client.js").RouteIQ, intent: string, taskType?: string | undefined);
    step(opts?: {
        action?: string;
        rationale?: string;
    }): StepHandle;
    complete(opts?: {
        tokens?: number;
        costUsd?: number;
        cohort?: string;
    }): void;
    fail(category?: string): void;
    private _finish;
    [Symbol.dispose](): void;
}
