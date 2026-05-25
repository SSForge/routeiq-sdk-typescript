import { trace, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter as GrpcExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import * as crypto from "crypto";
import { TaskHandle, StepHandle } from "./handles.js";

const SDK_VERSION = "0.2.0";

export interface RouteIQOptions {
  agentId: string;
  otlpEndpoint?: string;
  tenantId?: string;
  model?: string;
  environment?: string;
  agentVersion?: string;
  apiKey?: string;
}

export class RouteIQ {
  readonly agentId: string;
  readonly tenantId: string;
  readonly model?: string;
  readonly environment: string;
  readonly agentVersion: string;
  readonly sessionId: string;
  readonly _tracer: Tracer;
  private readonly _provider: BasicTracerProvider;

  constructor(opts: RouteIQOptions) {
    this.agentId = opts.agentId;
    this.tenantId = opts.tenantId ?? "default";
    this.model = opts.model;
    this.environment = opts.environment ?? "production";
    this.agentVersion = opts.agentVersion ?? "1.0.0";
    this.sessionId = crypto.randomUUID();

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

  _envelope(task?: TaskHandle, step?: StepHandle): Record<string, string> {
    const attrs: Record<string, string> = {
      "routeiq.agent.id": this.agentId,
      "routeiq.tenant.id": this.tenantId,
      "routeiq.environment": this.environment,
      "routeiq.session.id": this.sessionId,
    };
    if (task) {
      attrs["routeiq.task.id"] = task.taskId;
      attrs["routeiq.run.id"] = task.runId;
    }
    if (step) attrs["routeiq.step.id"] = step.stepId;
    if (this.model) attrs["routeiq.version.model.name"] = this.model;
    if (this.agentVersion) attrs["routeiq.version.agent"] = this.agentVersion;
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
