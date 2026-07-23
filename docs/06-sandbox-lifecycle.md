# 06 — Sandbox lifecycles and snapshot cost hygiene (phase 5)

There are **two independent sandbox lifecycles** in this pattern, with separate env
knobs. Confusing them is the #1 source of mystery Vercel costs. Read this in full
before touching either.

| | eve's own channel sandbox | harness template/forks |
|---|---|---|
| Defined in | [`agent/sandbox.ts`](../agent/sandbox.ts) (`defineSandbox`) | [`agent/lib/dev-agent.ts`](../agent/lib/dev-agent.ts) (`createVercelSandbox`) |
| Purpose | tool-exec environment for the eve loop (channel checkouts, bash) | the dev-agent's world (estate clones, Claude Code CLI) |
| Persistence | one durable sandbox per session; idle-expires → snapshot → resumes | one persistent TEMPLATE + a throwaway FORK per run |
| Knobs | `SANDBOX_IDLE_TIMEOUT_MS` (5 min), `SANDBOX_SNAPSHOT_EXPIRATION_MS` (7 d) | provider opts + `TEMPLATE_SNAPSHOT_EXPIRATION_MS` (7 d) |

Note the two 7-day expiration knobs are **different variables for different
lifecycles** — that separation is deliberate; do not merge them.

## Lifecycle 1: eve's channel sandbox

```ts
export default defineSandbox({
  backend: defaultBackend({
    vercel: {
      timeout: resolveSandboxIdleTimeoutMs(),                  // 5 min default
      snapshotExpiration: resolveSandboxSnapshotExpirationMs(), // 7 d default
    },
  }),
  async onSession({ use }) {
    const sandbox = await use();
    // /workspace is created uid 1001; commands run as root → git aborts every
    // checkout with "dubious ownership". Gotcha #9 — seen in production.
    await sandbox.run({ command: "git config --global --add safe.directory /workspace" });
  },
});
```

- `timeout` is an **inactivity** timeout, not a turn limiter: a running turn's own
  activity keeps resetting it; only genuine idle time between turns expires it.
  Expiry costs a snapshot-resume on the next turn, not a rebuild — so keep it short
  (5 min) to kill billed idle compute fast.
- Env resolvers live in [`agent/lib/sandbox-config.ts`](../agent/lib/sandbox-config.ts)
  as pure functions, because `sandbox.ts` calls `defineSandbox` at import time and
  is untestable directly. Overrides are guarded with `Number.isFinite(n) && n > 0` —
  a plain `Number(x) || default` lets negatives through.
- Editing `sandbox.ts` at all is a sandbox-**definition** change: every existing
  durable session gets a replacement sandbox on its next turn (`onSession` re-runs).
  Keep `onSession` idempotent so that's harmless.
- Suspended eve durable sessions show as Active `workflowEntry` runs in the Vercel
  dashboard — zero compute, not errors.

## Lifecycle 2: the harness template and its forks

Provider configuration (in `dev-agent.ts`):

```ts
createVercelSandbox({
  runtime: "node22",          // match the TARGET repo's engines, not the host's (gotcha #3)
  resources: { vcpus: 8 },
  timeout: 45 * 60 * 1000,
  ports: [4000],              // the claude-code bridge needs ≥1 exposed TCP port
  tags: { app: "{{AGENT_NAME}}" },  // makes sweeps and dashboard filtering possible
  snapshotExpiration: resolveTemplateSnapshotExpirationMs(),  // 7 d
  keepLastSnapshots: { count: 2, deleteEvicted: true },
})
```

Retention params must be **unconditional** — on the provider itself, not only on
explicit warm calls. The provider caches the template snapshotId in memory *per
Fluid function instance*, so every fresh instance re-runs `getOrCreate` on the
template, re-stops it, and mints another full-size snapshot. Without retention on
that implicit path, warms leak untended multi-GB snapshots (observed live in the
reference: 3 snapshots across 4 runs, one with no expiration at all — `getOrCreate`
defaults `snapshotExpiration` to never when unset).

### Why `keepLastSnapshots: { count: 2 }` — never 1

Eviction fires exactly when a newer same-name snapshot is minted — which is exactly
the moment *other* warm function instances still hold the previous snapshotId in
their in-memory cache. `count: 1` deletes it out from under them and poisons every
later fork on those instances; `count: 2` keeps one grace generation. This is
gotcha #5 and it cost a real debugging session. Do not "optimize" it back to 1.

### The stop-vs-delete trap (fork teardown)

The provider session's default `destroy()` is `stop()` → `delete()`, and **`stop()`
always mints a full-size (~2.6 GB) snapshot that `delete()` does NOT
cascade-remove.** For a per-run throwaway fork that is pure waste plus a 1–2 minute
publish race the sweeps then have to chase. The lib patches every freshly-created
fork session so `destroy()` calls `sandbox.delete()` directly — no stop, no
snapshot — with the original destroy as fallback if the direct delete throws
(gotcha #4).

Scope discipline: **only fork sessions'** destroy is patched. The template's
stop-snapshot *is* the template (wanted). `resumeSession` stays untouched — a
resumed session's stop-snapshot is its resume point.

Also: `session.destroy()` runs in `finally`, but a cleanup failure never discards
an already-computed result — it's swallowed and attached as a one-line redacted note.

## The three sweeps (backstops, all fail-soft)

Implemented in [`agent/lib/template-sweep.ts`](../agent/lib/template-sweep.ts):

1. **`sweepSessionSnapshots(sessionId)`** — after every run AND on `createSession`
   failure. Deletes by **exact name** (`ai-sdk-harness-session-<sessionId>`) only.
   Never sweep broadly by name pattern: eve's own continuity snapshots live in the
   same Vercel project.
2. **`sweepOrphanForkSnapshots()`** — deferred orphan collection: deletes fork
   snapshots older than 30 minutes (the publish race means a just-minted snapshot
   may not be listable yet) whose source session belongs to no live lineage
   (template + eve sandboxes are protected). **Fail-closed**: if the protection set
   is only partially built, skip the sweep rather than risk deleting a live lineage.
3. **`sweepStaleTemplates()`** — on warm: removes prior-identity template sandboxes
   (after a `RECIPE_VERSION` bump or estate change) and their snapshots explicitly —
   API removal does not reliably cascade. "Current" is identified by recency, not name.

Sweeps 2 and 3 also run from the daily maintenance schedule
([`agent/schedules/template-maintenance.md`](../agent/schedules/template-maintenance.md)),
so hygiene happens even on days with zero traffic. Every sweep logs a compact
one-line summary (kept/swept **by name**, counts) so a mis-sweep is diagnosable
from the run log alone.

The daily warm itself (gotcha #11) serves three purposes: the incremental git sync
stays small, the template snapshot never hits its 7-day expiration (which would
force the next real run to pay a cold rebuild), and the sweeps run daily.

## Steady-state inventory (what "healthy" looks like)

Check the Vercel dashboard (Sandboxes) after a few days of operation. Healthy is
exactly:

- **1** harness template sandbox + **≤2** template snapshots (`keepLastSnapshots`);
- eve channel: template snapshot ≤7 d old, session snapshots ≤24 h (eve-managed);
- at most 1 fork snapshot pending <30 min between runs (only if a fallback
  stop+delete fired — the teardown patch normally keeps this at zero);
- **nothing else.**

Anything beyond this inventory is a leak — find which of the three mechanisms
(provider retention, teardown patch, sweeps) missed it. Backstop for everything:
the 7-day `snapshotExpiration` means leaks self-heal within a week even if every
sweep fails.

## Cost quick reference

- Fork boot from a warm template: seconds. Cold template build: minutes — which is
  why warming is out-of-band ([docs/05-dev-agent.md](05-dev-agent.md) §Time budget).
- Platform step retries on a dirty kill: up to 3 × fresh 8-vCPU sandbox — the most
  expensive failure mode; the 700s self-budget exists to make it unreachable.
- Idle compute: the eve sandbox's 5-min idle timeout is the lever; a harness fork
  dies with its run.

## Verification

- `pnpm test` — `sandbox-config.test.ts` and `template-sweep.test.ts` cover the
  env-guard and sweep-selection logic.
- Trigger `warm_sandbox` twice in a row; the second call must be a fast no-op
  (`ready: true`, no rebuild) and the sweep summary in the log must report nothing
  unexpectedly swept.
- Bump `RECIPE_VERSION`, warm again: exactly one new template appears and the
  stale one (plus its snapshots) is swept.
- Run one real capability, wait ~30 min, then audit the sandbox/snapshot inventory
  against the steady-state list above. Zero fork snapshots is the expected result.

Next: [docs/07-ops.md](07-ops.md) — env vars, CI, and the external health check.
