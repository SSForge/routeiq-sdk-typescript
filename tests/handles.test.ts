import { describe, it, expect, beforeEach } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import * as crypto from "crypto";
import { RouteIQ } from "../src/client.js";
import { TaskHandle, StepHandle, ToolHandle } from "../src/handles.js";

function makeTestRiq(): { riq: RouteIQ; exporter: InMemorySpanExporter } {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

  // Bypass constructor OTel setup — inject test provider directly
  const riq = Object.create(RouteIQ.prototype) as RouteIQ;
  Object.assign(riq, {
    agentId: "test-agent",
    tenantId: "test-tenant",
    environment: "test",
    model: "gpt-4o",
    agentVersion: "1.0.0",
    sessionId: crypto.randomUUID(),
    _provider: provider,
    _tracer: provider.getTracer("routeiq.sdk", "0.2.0"),
  });
  return { riq, exporter };
}

function byName(spans: ReadableSpan[]): Map<string, ReadableSpan> {
  return new Map(spans.map((s) => [s.name, s]));
}

describe("TaskHandle", () => {
  it("span name starts with task:", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("find Paris");
    }
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names.some((n) => n.startsWith("task:"))).toBe(true);
  });

  it("envelope attributes are set", () => {
    const { riq, exporter } = makeTestRiq();
    let taskId: string;
    {
      using task = riq.task("find Paris");
      taskId = task.taskId;
    }
    const span = exporter.getFinishedSpans().find((s) => s.name.startsWith("task:"))!;
    expect(span.attributes["routeiq.agent.id"]).toBe("test-agent");
    expect(span.attributes["routeiq.session.id"]).toBe(riq.sessionId);
    expect(span.attributes["routeiq.task.id"]).toBe(taskId);
    expect(span.attributes["routeiq.task.input_intent"]).toBe("find Paris");
    expect(span.attributes["routeiq.version.model.name"]).toBe("gpt-4o");
  });

  it("complete sets success status", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      task.complete({ tokens: 100, costUsd: 0.001, cohort: "test" });
    }
    const span = exporter.getFinishedSpans().find((s) => s.name.startsWith("task:"))!;
    expect(span.attributes["routeiq.task.completion_status"]).toBe("1");
    expect(span.attributes["routeiq.task.total_tokens"]).toBe(100);
    expect(span.attributes["routeiq.task.cost_usd"]).toBe(0.001);
    expect(span.attributes["routeiq.task.cohort"]).toBe("test");
  });

  it("fail sets failure status", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      task.fail("tool_error");
    }
    const span = exporter.getFinishedSpans().find((s) => s.name.startsWith("task:"))!;
    expect(span.attributes["routeiq.task.completion_status"]).toBe("2");
    expect(span.attributes["routeiq.task.failure_category"]).toBe("tool_error");
  });

  it("auto-succeeds on clean exit", () => {
    const { riq, exporter } = makeTestRiq();
    { using task = riq.task("q"); }
    const span = exporter.getFinishedSpans().find((s) => s.name.startsWith("task:"))!;
    expect(span.attributes["routeiq.task.completion_status"]).toBe("1");
  });
});

describe("StepHandle", () => {
  it("span name starts with step:", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using step = task.step({ action: "tool_call" }); }
    }
    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names.some((n) => n.startsWith("step:"))).toBe(true);
  });

  it("carries task_id and step_id", () => {
    const { riq, exporter } = makeTestRiq();
    let taskId: string, stepId: string;
    {
      using task = riq.task("q");
      taskId = task.taskId;
      { using step = task.step(); stepId = step.stepId; }
    }
    const span = exporter.getFinishedSpans().find((s) => s.name.startsWith("step:"))!;
    expect(span.attributes["routeiq.task.id"]).toBe(taskId);
    expect(span.attributes["routeiq.step.id"]).toBe(stepId);
  });

  it("index increments per task", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using _s = task.step(); }
      { using _s = task.step(); }
    }
    const steps = exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith("step:"))
      .sort((a, b) => (a.attributes["routeiq.step.index"] as number) - (b.attributes["routeiq.step.index"] as number));
    expect(steps[0].attributes["routeiq.step.index"]).toBe(1);
    expect(steps[1].attributes["routeiq.step.index"]).toBe(2);
  });
});

describe("ToolHandle", () => {
  it("span name is tool:<name>", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using step = task.step(); { using _t = step.tool("search", { query: "Paris" }); } }
    }
    expect(exporter.getFinishedSpans().some((s) => s.name === "tool:search")).toBe(true);
  });

  it("success sets result_status=1", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using step = task.step(); { using tool = step.tool("search"); tool.success({ latencyMs: 50 }); } }
    }
    const span = exporter.getFinishedSpans().find((s) => s.name === "tool:search")!;
    expect(span.attributes["routeiq.tool.result_status"]).toBe("1");
    expect(span.attributes["routeiq.tool.latency_ms"]).toBe(50);
  });

  it("fail sets result_status=2", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using step = task.step(); { using tool = step.tool("search"); tool.fail({ errorCode: "TIMEOUT" }); } }
    }
    const span = exporter.getFinishedSpans().find((s) => s.name === "tool:search")!;
    expect(span.attributes["routeiq.tool.result_status"]).toBe("2");
    expect(span.attributes["routeiq.tool.error_code"]).toBe("TIMEOUT");
  });

  it("auto-succeeds on clean exit", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using step = task.step(); { using _t = step.tool("search"); } }
    }
    const span = exporter.getFinishedSpans().find((s) => s.name === "tool:search")!;
    expect(span.attributes["routeiq.tool.result_status"]).toBe("1");
  });

  it("arguments_hash is 16 hex chars", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using step = task.step(); { using _t = step.tool("search", { query: "Paris" }); } }
    }
    const span = exporter.getFinishedSpans().find((s) => s.name === "tool:search")!;
    const hash = span.attributes["routeiq.tool.arguments_hash"] as string;
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("permission level maps correctly", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using step = task.step(); { using _t = step.tool("write_file", {}, "READ_WRITE"); } }
    }
    const span = exporter.getFinishedSpans().find((s) => s.name === "tool:write_file")!;
    expect(span.attributes["routeiq.tool.permission_level"]).toBe("2");
  });

  it("session_id is same across all spans", () => {
    const { riq, exporter } = makeTestRiq();
    {
      using task = riq.task("q");
      { using step = task.step(); { using _t = step.tool("search"); } }
    }
    const sessionIds = new Set(
      exporter.getFinishedSpans().map((s) => s.attributes["routeiq.session.id"]),
    );
    expect(sessionIds.size).toBe(1);
    expect(sessionIds.has(riq.sessionId)).toBe(true);
  });
});
