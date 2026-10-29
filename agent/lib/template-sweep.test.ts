import { describe, expect, it } from "vitest";
import {
  decideStaleTemplateSweep,
  isHarnessTemplateName,
  MIN_SWEEP_AGE_MS,
  SANDBOX_TAG_KEY,
  SANDBOX_TAG_VALUE,
  type SandboxListItem,
} from "./template-sweep.ts";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000; // fixed reference instant

function sandbox(
  overrides: Partial<SandboxListItem> & Pick<SandboxListItem, "name">,
): SandboxListItem {
  return {
    tags: { [SANDBOX_TAG_KEY]: SANDBOX_TAG_VALUE },
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    ...overrides,
  };
}

describe("isHarnessTemplateName", () => {
  it("matches a genuine template name", () => {
    expect(isHarnessTemplateName("ai-sdk-harness-abcdef1234567890")).toBe(true);
  });

  it("matches the @ai-sdk/sandbox-vercel 1.0.168 template name (ai-sdk-harness-v3-<hex24>)", () => {
    expect(isHarnessTemplateName("ai-sdk-harness-v3-0123456789abcdef01234567")).toBe(true);
  });

  it("excludes a forked per-session sandbox name", () => {
    expect(isHarnessTemplateName("ai-sdk-harness-session-dev-task-example-app-abc")).toBe(
      false,
    );
  });

  it("excludes an unrelated sandbox name", () => {
    expect(isHarnessTemplateName("some-other-sandbox")).toBe(false);
  });

  it("excludes the bare prefix-less name", () => {
    expect(isHarnessTemplateName("ai-sdk-harness")).toBe(false);
  });
});

describe("decideStaleTemplateSweep", () => {
  it("ignores sandboxes without this app's tag", () => {
    const decision = decideStaleTemplateSweep({
      sandboxes: [
        sandbox({ name: "ai-sdk-harness-old", tags: { app: "some-other-app" } }),
      ],
      now: NOW,
    });
    expect(decision.current).toBeNull();
    expect(decision.stale).toEqual([]);
    expect(decision.skipped).toEqual([]);
    expect(decision.taggedSeen).toBe(0);
  });

  it("keeps exactly the freshest (updatedAt) genuine template as current and sweeps an older one", () => {
    const older = sandbox({
      name: "ai-sdk-harness-older",
      createdAt: NOW - 10 * HOUR,
      updatedAt: NOW - 10 * HOUR,
    });
    const newer = sandbox({
      name: "ai-sdk-harness-newer",
      createdAt: NOW - 5 * HOUR,
      updatedAt: NOW - 1 * HOUR,
    });

    const decision = decideStaleTemplateSweep({ sandboxes: [older, newer], now: NOW });

    expect(decision.current?.name).toBe("ai-sdk-harness-newer");
    expect(decision.stale.map((s) => s.name)).toEqual(["ai-sdk-harness-older"]);
    expect(decision.skipped).toEqual([
      { name: "ai-sdk-harness-newer", reason: "current template" },
    ]);
    expect(decision.taggedSeen).toBe(2);
  });

  it("never sweeps the current template even if it is the only one", () => {
    const only = sandbox({ name: "ai-sdk-harness-only", createdAt: NOW - 100 * HOUR });
    const decision = decideStaleTemplateSweep({ sandboxes: [only], now: NOW });
    expect(decision.current?.name).toBe("ai-sdk-harness-only");
    expect(decision.stale).toEqual([]);
  });

  it("recency-inversion: updatedAt, not createdAt, decides which template is current", () => {
    // freshByRecency was CREATED earlier but touched most recently;
    // staleByRecency was created later but never resumed again.
    const freshByRecency = sandbox({
      name: "ai-sdk-harness-fresh-updated",
      createdAt: NOW - 20 * HOUR,
      updatedAt: NOW - 1 * HOUR,
    });
    const staleByRecency = sandbox({
      name: "ai-sdk-harness-stale-updated",
      createdAt: NOW - 5 * HOUR,
      updatedAt: NOW - 15 * HOUR,
    });

    const decision = decideStaleTemplateSweep({
      sandboxes: [freshByRecency, staleByRecency],
      now: NOW,
    });

    expect(decision.current?.name).toBe("ai-sdk-harness-fresh-updated");
    expect(decision.stale.map((s) => s.name)).toEqual(["ai-sdk-harness-stale-updated"]);
  });

  it("never selects a fork-shaped (non-template) name as current when a genuine template exists", () => {
    const template = sandbox({
      name: "ai-sdk-harness-template",
      updatedAt: NOW - 5 * HOUR,
      createdAt: NOW - 5 * HOUR,
    });
    // Fresher updatedAt than the template, but a session name — only genuine
    // template names compete for "current".
    const fork = sandbox({
      name: "ai-sdk-harness-session-dev-task-example-app-xyz",
      createdAt: NOW - 2 * HOUR,
      updatedAt: NOW - 1 * HOUR,
    });

    const decision = decideStaleTemplateSweep({ sandboxes: [template, fork], now: NOW });

    expect(decision.current?.name).toBe("ai-sdk-harness-template");
    expect(decision.stale.map((s) => s.name)).toEqual([
      "ai-sdk-harness-session-dev-task-example-app-xyz",
    ]);
  });

  it("double-guards a young non-current sandbox (possible in-flight build or fork) below the age floor", () => {
    const current = sandbox({
      name: "ai-sdk-harness-current",
      updatedAt: NOW,
      createdAt: NOW - 5 * HOUR,
    });
    const youngFork = sandbox({
      name: "ai-sdk-harness-session-dev-task-example-app-xyz",
      createdAt: NOW - 5 * 60 * 1000, // 5 minutes old
      updatedAt: NOW - 5 * 60 * 1000,
    });

    const decision = decideStaleTemplateSweep({ sandboxes: [current, youngFork], now: NOW });

    expect(decision.stale).toEqual([]);
    expect(decision.skipped).toContainEqual(
      expect.objectContaining({ name: "ai-sdk-harness-session-dev-task-example-app-xyz" }),
    );
    // Skipped for age, but still counted among the tagged population.
    expect(decision.taggedSeen).toBe(2);
  });

  it("never sweeps a young stale TEMPLATE below the age floor either", () => {
    const current = sandbox({ name: "ai-sdk-harness-current", updatedAt: NOW });
    const youngTemplate = sandbox({
      name: "ai-sdk-harness-young",
      createdAt: NOW - 10 * 60 * 1000,
      updatedAt: NOW - 10 * 60 * 1000,
    });

    const decision = decideStaleTemplateSweep({
      sandboxes: [current, youngTemplate],
      now: NOW,
    });

    expect(decision.stale).toEqual([]);
    expect(decision.skipped).toContainEqual(
      expect.objectContaining({ name: "ai-sdk-harness-young" }),
    );
  });

  it("sweeps a lingering fork-shaped sandbox once past the age floor (crashed run that never destroyed itself)", () => {
    const current = sandbox({ name: "ai-sdk-harness-current", updatedAt: NOW });
    const orphanFork = sandbox({
      name: "ai-sdk-harness-session-dev-task-example-app-xyz",
      createdAt: NOW - 2 * HOUR,
      updatedAt: NOW - 2 * HOUR,
    });

    const decision = decideStaleTemplateSweep({ sandboxes: [current, orphanFork], now: NOW });

    expect(decision.stale.map((s) => s.name)).toEqual([
      "ai-sdk-harness-session-dev-task-example-app-xyz",
    ]);
  });

  it("honors a custom minAgeMs override", () => {
    const current = sandbox({ name: "ai-sdk-harness-current", updatedAt: NOW });
    const borderline = sandbox({
      name: "ai-sdk-harness-borderline",
      createdAt: NOW - 10 * 60 * 1000,
      updatedAt: NOW - 10 * 60 * 1000,
    });

    const decision = decideStaleTemplateSweep({
      sandboxes: [current, borderline],
      now: NOW,
      minAgeMs: 5 * 60 * 1000,
    });

    expect(decision.stale.map((s) => s.name)).toEqual(["ai-sdk-harness-borderline"]);
  });

  it("defaults minAgeMs to MIN_SWEEP_AGE_MS (1 hour)", () => {
    expect(MIN_SWEEP_AGE_MS).toBe(HOUR);
  });

  it("returns no current and no stale sandboxes for an empty list", () => {
    const decision = decideStaleTemplateSweep({ sandboxes: [], now: NOW });
    expect(decision).toEqual({ current: null, stale: [], skipped: [], taggedSeen: 0 });
  });

  // ── M-2: prefix-rename survival ──────────────────────────────────────
  //
  // If @ai-sdk/sandbox-vercel ever renames its TEMPLATE_NAME_PREFIX, every
  // tagged template sandbox stops matching `isHarnessTemplateName` in the
  // same release — including the one `warmSandboxTemplate()` just
  // created-or-resumed immediately before this sweep runs. Falling through
  // to "no name matched => nothing is current => everything tagged is
  // stale" would delete the one sandbox that is actually current. These
  // pin the fallback: when no tagged sandbox matches the name pattern, the
  // freshest-updatedAt tagged sandbox of ANY name is protected instead.

  it("M-2 regression pin: when no tagged sandbox name matches the template pattern, the freshest-updatedAt tagged sandbox is protected instead of swept", () => {
    const renamedNewer = sandbox({
      name: "harness-renamed-prefix-newer",
      createdAt: NOW - 5 * HOUR,
      updatedAt: NOW - 1 * HOUR,
    });
    const renamedOlder = sandbox({
      name: "harness-renamed-prefix-older",
      createdAt: NOW - 20 * HOUR,
      updatedAt: NOW - 10 * HOUR,
    });

    const decision = decideStaleTemplateSweep({
      sandboxes: [renamedNewer, renamedOlder],
      now: NOW,
    });

    expect(decision.current?.name).toBe("harness-renamed-prefix-newer");
    expect(decision.stale.map((s) => s.name)).toEqual(["harness-renamed-prefix-older"]);
    expect(decision.skipped).toEqual([
      {
        name: "harness-renamed-prefix-newer",
        reason:
          "no tagged sandbox name matched the harness template pattern; protecting the freshest-updatedAt tagged sandbox as presumed-current (possible upstream template prefix rename — see decideStaleTemplateSweep's doc comment)",
      },
    ]);
  });
});
