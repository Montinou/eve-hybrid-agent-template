import { describe, expect, it } from "vitest";
import {
  decideDeadEveSessionSweep,
  decideEveTemplateRenewal,
  decideEveTemplateSweep,
  EVE_SESSION_NAME_PREFIX,
  EVE_TEMPLATE_NAME_PREFIX,
  MIN_EVE_SWEEP_AGE_MS,
  pickCurrentEveTemplate,
  resolveEveTemplateRenewBelowMs,
  resolveEveTemplateSnapshotExpirationMs,
  type EveSandboxItem,
} from "./eve-sandbox.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;

function tpl(suffix: string, overrides: Partial<EveSandboxItem> = {}): EveSandboxItem {
  return {
    name: `${EVE_TEMPLATE_NAME_PREFIX}vercel-d0c4a139e6bb6c3b-${suffix}`,
    status: "stopped",
    createdAt: NOW - 2 * DAY,
    currentSnapshotId: `snap_${suffix}`,
    ...overrides,
  };
}

function ses(suffix: string, overrides: Partial<EveSandboxItem> = {}): EveSandboxItem {
  return {
    name: `${EVE_SESSION_NAME_PREFIX}vercel-d0c4a139e6bb6c3b-abc-wrun_${suffix}-__root__`,
    status: "stopped",
    createdAt: NOW - 2 * DAY,
    currentSnapshotId: `snap_${suffix}`,
    ...overrides,
  };
}

describe("pickCurrentEveTemplate", () => {
  it("returns the most recently created template", () => {
    const newest = tpl("new", { createdAt: NOW - HOUR });
    const picked = pickCurrentEveTemplate([
      tpl("old", { createdAt: NOW - 10 * DAY }),
      newest,
      tpl("mid", { createdAt: NOW - 3 * DAY }),
    ]);
    expect(picked?.name).toBe(newest.name);
  });

  it("ignores session sandboxes", () => {
    expect(pickCurrentEveTemplate([ses("a", { createdAt: NOW })])).toBeNull();
  });

  it("returns null when nothing matches the template prefix", () => {
    expect(pickCurrentEveTemplate([])).toBeNull();
  });
});

describe("decideEveTemplateRenewal", () => {
  it("rebuilds when no template exists at all", () => {
    const decision = decideEveTemplateRenewal({ template: null, snapshot: null, now: NOW });
    expect(decision.action).toBe("rebuild");
  });

  it("rebuilds when the template has no currentSnapshotId", () => {
    const decision = decideEveTemplateRenewal({
      template: tpl("a", { currentSnapshotId: undefined }),
      snapshot: null,
      now: NOW,
    });
    expect(decision.action).toBe("rebuild");
  });

  it("rebuilds when the referenced snapshot is gone — the production outage shape", () => {
    const decision = decideEveTemplateRenewal({
      template: tpl("a"),
      snapshot: null,
      now: NOW,
    });
    expect(decision.action).toBe("rebuild");
    expect(decision.reason).toContain("410");
  });

  it("rebuilds when the referenced snapshot is deleted", () => {
    const decision = decideEveTemplateRenewal({
      template: tpl("a"),
      snapshot: { status: "deleted" },
      now: NOW,
    });
    expect(decision.action).toBe("rebuild");
  });

  it("skips while the snapshot has more life than the renewal floor", () => {
    const decision = decideEveTemplateRenewal({
      template: tpl("a"),
      snapshot: { status: "created", expiresAt: NOW + 6 * DAY },
      now: NOW,
      renewBelowMs: 3 * DAY,
    });
    expect(decision.action).toBe("skip");
    expect(decision.remainingMs).toBe(6 * DAY);
  });

  it("renews once the snapshot drops below the floor", () => {
    const decision = decideEveTemplateRenewal({
      template: tpl("a"),
      snapshot: { status: "created", expiresAt: NOW + 2 * DAY },
      now: NOW,
      renewBelowMs: 3 * DAY,
    });
    expect(decision.action).toBe("renew");
  });

  it("renews an already-expired-but-still-listed snapshot", () => {
    const decision = decideEveTemplateRenewal({
      template: tpl("a"),
      snapshot: { status: "created", expiresAt: NOW - HOUR },
      now: NOW,
      renewBelowMs: 3 * DAY,
    });
    expect(decision.action).toBe("renew");
    expect(decision.reason).toContain("expired");
  });

  it("skips a snapshot with no expiration at all", () => {
    const decision = decideEveTemplateRenewal({
      template: tpl("a"),
      snapshot: { status: "created" },
      now: NOW,
    });
    expect(decision.action).toBe("skip");
  });

  it("treats a 24h-expiry snapshot as due — the pre-fix production shape", () => {
    // A build-minted snapshot carries SANDBOX_SNAPSHOT_EXPIRATION_MS (24h in
    // production), far below the 7d floor, so the first warm after a deploy
    // always replaces it with a 30d one.
    const decision = decideEveTemplateRenewal({
      template: tpl("a"),
      snapshot: { status: "created", expiresAt: NOW + 20 * HOUR },
      now: NOW,
    });
    expect(decision.action).toBe("renew");
  });
});

describe("decideEveTemplateSweep", () => {
  it("keeps the current template and sweeps the rest", () => {
    const current = tpl("current", { createdAt: NOW - HOUR });
    const decision = decideEveTemplateSweep({
      items: [current, tpl("old1", { createdAt: NOW - 10 * DAY }), tpl("old2")],
      currentName: current.name,
      now: NOW,
    });
    expect(decision.sweep.map((s) => s.name)).toEqual([
      tpl("old1").name,
      tpl("old2").name,
    ]);
    expect(decision.skipped).toContainEqual({ name: current.name, reason: "current template" });
  });

  it("never sweeps a template younger than the age floor", () => {
    const decision = decideEveTemplateSweep({
      items: [tpl("fresh", { createdAt: NOW - MIN_EVE_SWEEP_AGE_MS / 2 })],
      currentName: null,
      now: NOW,
    });
    expect(decision.sweep).toEqual([]);
    expect(decision.skipped[0]?.reason).toContain("in-flight build");
  });

  it("ignores session sandboxes entirely", () => {
    const decision = decideEveTemplateSweep({
      items: [ses("a")],
      currentName: null,
      now: NOW,
    });
    expect(decision.sweep).toEqual([]);
    expect(decision.skipped).toEqual([]);
  });
});

describe("decideDeadEveSessionSweep", () => {
  it("sweeps a stopped session whose snapshot is gone", () => {
    const dead = ses("dead");
    const decision = decideDeadEveSessionSweep({
      sessions: [{ item: dead, hasLiveSnapshot: false }],
      now: NOW,
    });
    expect(decision.sweep.map((s) => s.name)).toEqual([dead.name]);
  });

  it("never touches a session whose continuity snapshot is alive", () => {
    const alive = ses("alive");
    const decision = decideDeadEveSessionSweep({
      sessions: [{ item: alive, hasLiveSnapshot: true }],
      now: NOW,
    });
    expect(decision.sweep).toEqual([]);
    expect(decision.skipped).toContainEqual({
      name: alive.name,
      reason: "live continuity snapshot",
    });
  });

  it("never touches a running session even without a snapshot", () => {
    const running = ses("running", { status: "running" });
    const decision = decideDeadEveSessionSweep({
      sessions: [{ item: running, hasLiveSnapshot: false }],
      now: NOW,
    });
    expect(decision.sweep).toEqual([]);
    expect(decision.skipped[0]?.reason).toBe("status=running");
  });

  it("respects the age floor so a publishing snapshot is not raced", () => {
    const fresh = ses("fresh", { createdAt: NOW - MIN_EVE_SWEEP_AGE_MS / 2 });
    const decision = decideDeadEveSessionSweep({
      sessions: [{ item: fresh, hasLiveSnapshot: false }],
      now: NOW,
    });
    expect(decision.sweep).toEqual([]);
    expect(decision.skipped[0]?.reason).toContain("still be publishing");
  });
});

describe("env resolvers", () => {
  it("falls back to the 30d expiration / 7d renewal-floor defaults", () => {
    delete process.env.EVE_TEMPLATE_SNAPSHOT_EXPIRATION_MS;
    delete process.env.EVE_TEMPLATE_RENEW_BELOW_MS;
    expect(resolveEveTemplateSnapshotExpirationMs()).toBe(30 * DAY);
    expect(resolveEveTemplateRenewBelowMs()).toBe(7 * DAY);
  });

  it("rejects zero, negative and non-numeric overrides", () => {
    for (const bad of ["0", "-1000", "abc", ""]) {
      process.env.EVE_TEMPLATE_SNAPSHOT_EXPIRATION_MS = bad;
      expect(resolveEveTemplateSnapshotExpirationMs()).toBe(30 * DAY);
    }
    delete process.env.EVE_TEMPLATE_SNAPSHOT_EXPIRATION_MS;
  });

  it("accepts a positive override", () => {
    process.env.EVE_TEMPLATE_RENEW_BELOW_MS = String(12 * HOUR);
    expect(resolveEveTemplateRenewBelowMs()).toBe(12 * HOUR);
    delete process.env.EVE_TEMPLATE_RENEW_BELOW_MS;
  });
});
