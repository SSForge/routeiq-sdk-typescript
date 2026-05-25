import { type Tracer } from "@opentelemetry/api";
import { TaskHandle, StepHandle } from "./handles.js";
export interface RouteIQOptions {
    agentId: string;
    otlpEndpoint?: string;
    tenantId?: string;
    model?: string;
    environment?: string;
    agentVersion?: string;
    apiKey?: string;
}
export declare class RouteIQ {
    readonly agentId: string;
    readonly tenantId: string;
    readonly model?: string;
    readonly environment: string;
    readonly agentVersion: string;
    readonly sessionId: string;
    readonly _tracer: Tracer;
    private readonly _provider;
    constructor(opts: RouteIQOptions);
    task(intent: string, taskType?: string): TaskHandle;
    flush(): Promise<void>;
    _envelope(task?: TaskHandle, step?: StepHandle): Record<string, string>;
}
