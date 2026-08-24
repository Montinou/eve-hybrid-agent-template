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

### The eve template dies silently in production — and nothing repairs it

The knobs above govern eve's SESSION snapshots. Behind them sits a **template**
that nothing in your app touches, and on a Vercel deployment it cannot repair
itself:

1. eve provisions its template **only during a build**
   (`internal/nitro/host/vercel-build-prewarm.js`).
2. That template's snapshot expires on `snapshotExpiration`. Once it lapses,
   the sandbox record survives as `stopped` with a `currentSnapshotId`
   pointing at a deleted snapshot, and resuming it returns **HTTP 410**.
3. eve's repair path — re-prewarm, then retry — is gated on
   `compiledArtifactsSource.kind === "disk"`
   (`execution/sandbox/ensure.js`, `createBackendHandleWithPrewarmRetry`). A
   deployment is never `"disk"`, so `SandboxTemplateNotProvisionedError` is
   rethrown and **every** later session creation fails until someone
   redeploys. Verified present in eve 0.27 through 0.44.3.

Observed live: an agent's `SANDBOX_SNAPSHOT_EXPIRATION_MS` was 24 h, its last
deploy was a Tuesday, and from Thursday onward **not one sandbox was created
for twelve days**. `/eve/v1/health` answered 200 the entire time. Only the
tools needing a checkout failed, and they degraded honestly instead of
erroring — so nothing alerted, and the daily traffic looked normal.

Two platform facts make the fix cheap ([persistent sandboxes][ps]): snapshot
TTL is *"measured from the snapshot's last use. The timer resets each time the
snapshot is used"*, and it defaults to **30 days**. Under steady traffic a
template never expires at all; the TTL only has to cover a drought. Shortening
`SANDBOX_SNAPSHOT_EXPIRATION_MS` to save storage shortens it for the TEMPLATE
too — which is what turns a quiet week into an outage.

[`agent/lib/eve-sandbox.ts`](../agent/lib/eve-sandbox.ts) gives eve's template
the same care the harness template already gets, from the same daily schedule:

- **Renew** before it lapses, in this exact order — each step forced by a
  measured behaviour: `Sandbox.get({resume:false})` → `update({
  snapshotExpiration, keepLastSnapshots:{count:2} })` (never auto-resumes) →
  a trivial `runCommand` to resume → **`snapshot({ expiration })`** →
  `update({ currentSnapshotId })` → `stop()`.
  The explicit `snapshot()` is load-bearing: **`stop()` does not mint a new
  snapshot for a template.** It reuses the existing id and re-applies *that
  snapshot's own recorded TTL*, so a snapshot minted by a build running a 24 h
  expiration keeps renewing in 24 h steps forever, no matter what the sandbox
  record says. Only `snapshot({expiration})` produces the TTL you asked for;
  the `stop()` afterwards leaves `currentSnapshotId` pointing at it.
- **Rebuild** when it is already gone, by firing a Vercel Deploy Hook
  (`EVE_DEPLOY_HOOK_URL`). A build is the only supported way to reprovision an
  eve template in production.
- **Sweep dead session records.** `ensureSession()` resolves a session by name
  and hands back the existing record without checking that it can still
  resume, so a session whose snapshot expired 410s forever. Deleting the
  record is what lets that durable session come back — a repair, not hygiene.

Implementation notes worth keeping if you rewrite it:

- eve's names are internal (`eve-sbx-tpl-<backend>-<scope16>-<hash20>`,
  `eve-sbx-ses-…`). Replicate the prefixes literally and fail *safe* when they
  stop matching: no match must mean "sweep nothing", never "sweep everything".
- eve templates carry **no tags**, so "current" can only be the most recently
  *created* template — which is correct, because eve creates it during a build.
- `Sandbox.list()`'s `namePrefix` is only valid together with `sortBy: "name"`;
  passing it alone returns HTTP 400. One unfiltered listing split client-side
  is simpler when a project holds a handful of sandboxes.

[ps]: https://vercel.com/docs/sandbox/concepts/persistent-sandboxes

## Lifecycle 2: the harness template and its forks

Provider configuration (in `dev-agent.ts`):

```ts
createVercelSandbox({
  runtime: sandboxRuntime(),  // from estate.ts: the TARGET repos' engines pin,
                              // never the host's (gotcha #3)
  resources: { vcpus: 8 },
  timeout: 45 * 60 * 1000,
  ports: [4000],              // the claude-code bridge needs ≥1 exposed TCP port
  tags: { app: SANDBOX_TAG_VALUE },  // template-sweep.ts; CUSTOMIZE to {{AGENT_NAME}}
                                     // — makes sweeps and dashboard filtering possible
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
- eve channel: its own template plus per-session snapshots, all eve-managed and
  expiring per `SANDBOX_SNAPSHOT_EXPIRATION_MS` (7 d default);
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
