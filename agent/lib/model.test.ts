import { afterEach, describe, expect, it, vi } from "vitest";
import { commandModelId, orchestratorModelId } from "./model.ts";

describe("model.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults orchestratorModelId when ORCHESTRATOR_MODEL is unset", () => {
    // No stubbing here on purpose: this must hold under the real process env
    // (CI doesn't set ORCHESTRATOR_MODEL), proving rollback is just "unset
    // the env var" rather than a code change.
    expect(orchestratorModelId).toBe("google/gemini-2.5-flash-lite");
  });

  it("defaults commandModelId when COMMAND_MODEL is unset", () => {
    expect(commandModelId).toBe("anthropic/claude-haiku-4.5");
  });

  it("resolves orchestratorModelId from ORCHESTRATOR_MODEL on a fresh module evaluation", async () => {
    // Both ids are computed once at module evaluation time, so picking up an
    // env override requires resetting vitest's module registry and
    // re-importing, rather than stubbing and reading the already-evaluated
    // top-level binding.
    vi.stubEnv("ORCHESTRATOR_MODEL", "anthropic/claude-sonnet-4.5");
    vi.resetModules();

    const fresh = await import("./model.ts");

    expect(fresh.orchestratorModelId).toBe("anthropic/claude-sonnet-4.5");
  });

  it("resolves commandModelId from COMMAND_MODEL on a fresh module evaluation", async () => {
    vi.stubEnv("COMMAND_MODEL", "anthropic/claude-opus-4.1");
    vi.resetModules();

    const fresh = await import("./model.ts");

    expect(fresh.commandModelId).toBe("anthropic/claude-opus-4.1");
  });
});
