import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_TOOL_STEP_MS,
  resolveSandboxSnapshotExpirationMs,
  resolveSandboxTimeoutMs,
} from "./sandbox-config.ts";

describe("sandbox-config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults resolveSandboxTimeoutMs to 30 minutes when neither SANDBOX_TIMEOUT_MS nor SANDBOX_IDLE_TIMEOUT_MS is set", () => {
    // No stubbing here on purpose: this must hold under the real process env
    // (CI sets neither), proving rollback is just "unset the env var".
    // 30 minutes is eve's own default for Vercel session sandboxes.
    expect(resolveSandboxTimeoutMs()).toBe(30 * 60 * 1000);
  });

  it("floors the sandbox lifetime at one tool-call step", () => {
    // `timeout` is a hard lifetime (@vercel/sandbox: "Timeout in milliseconds
    // before the sandbox auto-terminates"), not an idle timeout. A tool call
    // runs inside one function invocation capped at maxDuration 800s
    // (scripts/copy-bridge-assets.mjs), so a lifetime below that could not
    // even cover one full step. The floor is a minimum, not a guarantee: the
    // lifetime counts from VM start.
    expect(MAX_TOOL_STEP_MS).toBe(800_000);
    expect(resolveSandboxTimeoutMs()).toBeGreaterThanOrEqual(MAX_TOOL_STEP_MS);
    vi.stubEnv("SANDBOX_TIMEOUT_MS", String(5 * 60 * 1000));
    expect(resolveSandboxTimeoutMs()).toBe(MAX_TOOL_STEP_MS);
  });

  it("reads SANDBOX_TIMEOUT_MS", () => {
    vi.stubEnv("SANDBOX_TIMEOUT_MS", String(45 * 60 * 1000));
    expect(resolveSandboxTimeoutMs()).toBe(45 * 60 * 1000);
  });

  it("accepts the old SANDBOX_IDLE_TIMEOUT_MS name as an alias", () => {
    vi.stubEnv("SANDBOX_IDLE_TIMEOUT_MS", String(20 * 60 * 1000));
    expect(resolveSandboxTimeoutMs()).toBe(20 * 60 * 1000);
  });

  it("falls through an invalid SANDBOX_TIMEOUT_MS to a valid alias", () => {
    vi.stubEnv("SANDBOX_TIMEOUT_MS", "abc");
    vi.stubEnv("SANDBOX_IDLE_TIMEOUT_MS", String(25 * 60 * 1000));
    expect(resolveSandboxTimeoutMs()).toBe(25 * 60 * 1000);
  });

  it("prefers SANDBOX_TIMEOUT_MS over the SANDBOX_IDLE_TIMEOUT_MS alias", () => {
    vi.stubEnv("SANDBOX_TIMEOUT_MS", String(40 * 60 * 1000));
    vi.stubEnv("SANDBOX_IDLE_TIMEOUT_MS", String(20 * 60 * 1000));
    expect(resolveSandboxTimeoutMs()).toBe(40 * 60 * 1000);
  });

  it("defaults resolveSandboxSnapshotExpirationMs to 7 days when SANDBOX_SNAPSHOT_EXPIRATION_MS is unset", () => {
    expect(resolveSandboxSnapshotExpirationMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("resolves the snapshot expiration from SANDBOX_SNAPSHOT_EXPIRATION_MS on a fresh module evaluation", async () => {
    vi.stubEnv("SANDBOX_SNAPSHOT_EXPIRATION_MS", "86400000");
    vi.resetModules();

    const fresh = await import("./sandbox-config.ts");

    expect(fresh.resolveSandboxSnapshotExpirationMs()).toBe(86_400_000);
  });

  it.each([
    ["0", "zero"],
    ["abc", "non-numeric"],
    ["-1000", "negative"],
    ["", "empty string"],
    ["NaN", "literal NaN"],
  ])(
    "falls back resolveSandboxTimeoutMs to the default on an invalid override (%s / %s)",
    async (value) => {
      vi.stubEnv("SANDBOX_TIMEOUT_MS", value);
      vi.stubEnv("SANDBOX_IDLE_TIMEOUT_MS", value);
      vi.resetModules();

      const fresh = await import("./sandbox-config.ts");

      expect(fresh.resolveSandboxTimeoutMs()).toBe(30 * 60 * 1000);
    },
  );

  it.each([
    ["0", "zero"],
    ["abc", "non-numeric"],
    ["-604800000", "negative"],
    ["", "empty string"],
  ])(
    "falls back resolveSandboxSnapshotExpirationMs to the default on an invalid override (%s / %s)",
    async (value) => {
      vi.stubEnv("SANDBOX_SNAPSHOT_EXPIRATION_MS", value);
      vi.resetModules();

      const fresh = await import("./sandbox-config.ts");

      expect(fresh.resolveSandboxSnapshotExpirationMs()).toBe(
        7 * 24 * 60 * 60 * 1000,
      );
    },
  );
});
