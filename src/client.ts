import { trace, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter as GrpcExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import * as crypto from "crypto";
import { TaskHandle, StepHandle } from "./handles.js";

const SDK_VERSION = "0.3.0";

export interface RouteIQOptions {
  agentId: string;
  /** Groups this agent under a named system (e.g. "checkout-bot"). */
  systemId?: string;
  /** End-user ID for per-user analytics. */
  userId?: string;
  otlpEndpoint?: string;
  tenantId?: string;
  model?: string;
  environment?: string;
  agentVersion?: string;
  apiKey?: string;
  /** Minimum acceptable task success rate (0–1), e.g. 0.95. */
  sloSuccessTarget?: number;
  /** p95 latency SLO in milliseconds, e.g. 2000. */
  sloP95MsTarget?: number;
}

export class RouteIQ {
  readonly agentId: string;
  readonly systemId?: string;
  readonly userId?: string;
  readonly tenantId: string;
  readonly model?: string;
  readonly environment: string;
  readonly agentVersion: string;
  readonly sessionId: string;
  readonly sloSuccessTarget?: number;
  readonly sloP95MsTarget?: number;
  readonly _tracer: Tracer;
  private readonly _provider: BasicTracerProvider;

  constructor(opts: RouteIQOptions) {
    this.agentId = opts.agentId;
    this.systemId = opts.systemId;
    this.userId = opts.userId;
    this.tenantId = opts.tenantId ?? "default";
    this.model = opts.model;
    this.environment = opts.environment ?? "production";
    this.agentVersion = opts.agentVersion ?? "1.0.0";
    this.sessionId = crypto.randomUUID();
    this.sloSuccessTarget = opts.sloSuccessTarget;
    this.sloP95MsTarget = opts.sloP95MsTarget;

    const resource = new Resource({
      "service.name": this.agentId,
      "service.version": this.agentVersion,
      "routeiq.sdk.version": SDK_VERSION,
    });

    this._provider = new BasicTracerProvider({ resource });
    this._provider.addSpanProcessor(
      new BatchSpanProcessor(makeExporter(opts.otlpEndpoint ?? "http://localhost:4317", opts.apiKey)),
    );
    this._tracer = this._provider.getTracer("routeiq.sdk", SDK_VERSION);
  }

  task(intent: string, taskType?: string): TaskHandle {
    return new TaskHandle(this, intent, taskType);
  }

  async flush(): Promise<void> {
    await this._provider.forceFlush();
  }

  _envelope(task?: TaskHandle, step?: StepHandle): Record<string, string | number> {
    const attrs: Record<string, string | number> = {
      "routeiq.agent.id":   this.agentId,
      "routeiq.tenant.id":  this.tenantId,
      "routeiq.environment": this.environment,
      "routeiq.session.id": this.sessionId,
    };
    if (this.systemId) attrs["routeiq.system.id"] = this.systemId;
    if (this.userId)   attrs["routeiq.user.id"]   = this.userId;
    if (task) {
      attrs["routeiq.task.id"] = task.taskId;
      attrs["routeiq.run.id"]  = task.runId;
    }
    if (step) attrs["routeiq.step.id"] = step.stepId;
    if (this.model)           attrs["routeiq.version.model.name"]  = this.model;
    if (this.agentVersion)    attrs["routeiq.version.agent"]       = this.agentVersion;
    if (this.sloSuccessTarget != null) attrs["routeiq.slo.success_target"] = this.sloSuccessTarget;
    if (this.sloP95MsTarget   != null) attrs["routeiq.slo.p95_ms_target"]  = this.sloP95MsTarget;
    return attrs;
  }
}

function makeExporter(endpoint: string, apiKey?: string): SpanExporter {
  const headers: Record<string, string> = {};
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;

  if (endpoint.startsWith("https://") || endpoint.includes(":4318")) {
    return new HttpExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
      headers,
    });
  }
  return new GrpcExporter({ url: endpoint, headers });
}
