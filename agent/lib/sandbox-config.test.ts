import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveSandboxIdleTimeoutMs,
  resolveSandboxSnapshotExpirationMs,
} from "./sandbox-config.ts";

describe("sandbox-config.ts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults resolveSandboxIdleTimeoutMs to 5 minutes when SANDBOX_IDLE_TIMEOUT_MS is unset", () => {
    // No stubbing here on purpose: this must hold under the real process env
    // (CI doesn't set SANDBOX_IDLE_TIMEOUT_MS), proving rollback is just
    // "unset the env var" rather than a code change.
    expect(resolveSandboxIdleTimeoutMs()).toBe(5 * 60 * 1000);
  });

  it("defaults resolveSandboxSnapshotExpirationMs to 7 days when SANDBOX_SNAPSHOT_EXPIRATION_MS is unset", () => {
    expect(resolveSandboxSnapshotExpirationMs()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("resolves the idle timeout from SANDBOX_IDLE_TIMEOUT_MS on a fresh module evaluation", async () => {
    // Reset vitest's module registry and re-import so the fresh module picks
    // up the stubbed env rather than relying on any cached top-level state.
    vi.stubEnv("SANDBOX_IDLE_TIMEOUT_MS", "120000");
    vi.resetModules();

    const fresh = await import("./sandbox-config.ts");

    expect(fresh.resolveSandboxIdleTimeoutMs()).toBe(120_000);
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
    "falls back resolveSandboxIdleTimeoutMs to the default on an invalid override (%s / %s)",
    async (value) => {
      vi.stubEnv("SANDBOX_IDLE_TIMEOUT_MS", value);
      vi.resetModules();

      const fresh = await import("./sandbox-config.ts");

      expect(fresh.resolveSandboxIdleTimeoutMs()).toBe(5 * 60 * 1000);
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
