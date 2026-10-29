# 06 — Sandbox lifecycles and snapshot cost hygiene (phase 5)

There are **two independent sandbox lifecycles** in this pattern, with separate env
knobs. Confusing them is the #1 source of mystery Vercel costs. Read this in full
before touching either.

| | eve's own channel sandbox | harness template/forks |
|---|---|---|
| Defined in | [`agent/sandbox.ts`](../agent/sandbox.ts) (`defineSandbox`) | [`agent/lib/dev-agent.ts`](../agent/lib/dev-agent.ts) (`createVercelNetworkSandboxSession`) |
| Purpose | tool-exec environment for the eve loop (channel checkouts, bash) | the dev-agent's world (estate clones, Claude Code CLI) |
| Persistence | one durable sandbox per session, created from the build's template snapshot; terminated after its lifetime → resumed from its saved filesystem on next access | one TEMPLATE snapshot per recipe identity + a throwaway non-persistent FORK per run |
| Knobs | `SANDBOX_TIMEOUT_MS` (30 min lifetime), `SANDBOX_SNAPSHOT_EXPIRATION_MS` (7 d) | create options + `TEMPLATE_SNAPSHOT_EXPIRATION_MS` (7 d) |

Note the two 7-day expiration knobs are **different variables for different
lifecycles** — that separation is deliberate; do not merge them.

## Lifecycle 1: eve's channel sandbox

```ts
export const environment = DefaultSandbox.environment({
  vercel: {
    timeout: resolveSandboxTimeoutMs(),                       // 30 min default
    snapshotExpiration: resolveSandboxSnapshotExpirationMs(), // 7 d default
  },
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  // /workspace is created uid 1001; commands run as root → git aborts every
  // checkout with "dubious ownership". Gotcha #9 — seen in production.
  await sandbox.run({ command: "git config --global --add safe.directory /workspace" });
  return sandbox;
});
```

- `environment` must be exported: `eve build` prepares it before any session
  exists. The `vercel` options are Vercel Sandbox create options; eve forwards
  them to every sandbox it creates (the build-time template and each session
  sandbox at first creation), never on resume.
- `timeout` is a **hard lifetime**, not an idle timeout. `@vercel/sandbox`
  documents it as *"Timeout in milliseconds before the sandbox
  auto-terminates"* and `extendTimeout()` as extending *"the lifetime of a
  sandbox"*; activity does not reset it, and eve's session handle does not
  expose `extendTimeout()`. Session sandboxes are persistent, so a terminated
  one resumes from its saved filesystem on the next access; only a command
  still running at that moment is lost. The default is 30 minutes (eve's own
  default, and the one `@ai-sdk/sandbox-vercel` picked because 5 minutes made
  "the VM expire between steps"), and overrides are floored at 800 s, the
  longest single tool-call step. `SANDBOX_IDLE_TIMEOUT_MS`, the old name, is
  still accepted as an alias; `SANDBOX_TIMEOUT_MS` wins when both are set.
- Env resolvers live in [`agent/lib/sandbox-config.ts`](../agent/lib/sandbox-config.ts)
  as pure functions, because `sandbox.ts` calls `defineSandbox` at import time and
  is untestable directly. Overrides are guarded with `Number.isFinite(n) && n > 0` —
  a plain `Number(x) || default` lets negatives through.
- eve reruns the selector until initialization succeeds, so keep the post-open
  setup repeat-safe. Editing `sandbox.ts` produces a new environment
  *generation*: new sessions use it, existing durable sessions keep their
  sandbox.
- Suspended eve durable sessions show as Active `workflowEntry` runs in the Vercel
  dashboard — zero compute, not errors.

### The eve template snapshot: lapsed means redeploy

The knobs above govern eve's SESSION sandboxes. Behind them sits the
**template snapshot** that `eve build` prepares. From eve's bundled docs
(`node_modules/eve/docs/sandbox/`):

- *"eve creates a temporary, non-persistent Vercel Sandbox during build,
  installs the base runtime, writes managed workspace and skill files, and runs
  the authored `prepare` callback … The build artifact records the snapshot ID.
  When a live session sandbox does not exist, eve creates it directly from that
  snapshot ID. Runtime does not need to look up the temporary template
  Sandbox."* (`vercel.mdx`)
- *"Production never prepares sandbox environments."* When the recorded
  snapshot is gone the runtime reports *"Sandbox template … is not available to
  this runtime"*, whose Vercel cause is *"The Vercel Sandbox snapshot expired
  or was deleted"*, and *"The runtime never recreates a template. Run
  `eve build` again and deploy its output."* (`troubleshooting.mdx`)

So nothing in the running app can renew or rebuild eve's template, and this
template does not try: the repair for a lapsed template is **a redeploy**, done
by a person. `warm_sandbox` warms only the harness template below and never
fires a deploy hook. The snapshot carries `SANDBOX_SNAPSHOT_EXPIRATION_MS`
(7 days by default), and per the [persistent sandboxes][ps] doc its TTL is
*"measured from the snapshot's last use. The timer resets each time the
snapshot is used"*: every new session sandbox created from it counts as a use,
so an agent with regular traffic keeps it alive. A week with no new session is
what lets it lapse. If your agent can sit idle that long, raise
`SANDBOX_SNAPSHOT_EXPIRATION_MS` (it also lengthens session-snapshot storage)
and rely on [`.github/workflows/sandbox-health.yml`](../.github/workflows/sandbox-health.yml)
([docs/07-ops.md](07-ops.md)) to tell you when a redeploy is needed.

Why this matters (observed live in the reference deployment): an agent's
`SANDBOX_SNAPSHOT_EXPIRATION_MS` was 24 h, its last deploy was a Tuesday, and
from Thursday onward **not one sandbox was created for twelve days**.
`/eve/v1/health` answered 200 the entire time. Only the tools needing a
checkout failed, and they degraded honestly instead of erroring — so nothing
alerted, and the daily traffic looked normal.

[ps]: https://vercel.com/docs/sandbox/concepts/persistent-sandboxes

## Lifecycle 2: the harness template and its forks

Create options (in `dev-agent.ts`, `buildDevSandboxCreateOptions()`), passed to
`@ai-sdk/sandbox-vercel`'s `createVercelNetworkSandboxSession` together with the
harness template (`createHarnessSandboxTemplate`: the Claude Code bridge recipe +
`onBootstrap`):

```ts
createVercelNetworkSandboxSession({
  runtime: sandboxRuntime(),  // from estate.ts: the TARGET repos' engines pin,
                              // never the host's (gotcha #3)
  resources: { vcpus: 8 },
  timeout: 45 * 60 * 1000,
  ports: [4000],              // the claude-code bridge needs ≥1 exposed TCP port
  tags: { app: SANDBOX_TAG_VALUE },  // template-sweep.ts; CUSTOMIZE to {{AGENT_NAME}}
                                     // — makes sweeps and dashboard filtering possible
  snapshotExpiration: resolveTemplateSnapshotExpirationMs(),  // 7 d
  persistent: false,          // forks mint no snapshot on stop/destroy
  template,                   // createHarnessSandboxTemplate(...)
  sandboxId: devForkSandboxId(sessionId),  // ai-sdk-harness-session-<sessionId>
})
```

How it works (`node_modules/@ai-sdk/sandbox-vercel/src/vercel-sandbox.ts` and
`utils.ts`): the template is a non-persistent sandbox named
`ai-sdk-harness-v<N>-<digest of the template identity>`, created once with
`Sandbox.getOrCreate`; its `onCreate` runs the bridge recipe and `onBootstrap`,
then takes one snapshot with `snapshotExpiration`. Every later call finds the
template by name, reads its snapshot, and creates a live fork from it. A new
recipe identity (a `RECIPE_VERSION` bump, a changed estate, a new bridge recipe)
means a new template name.

The caller owns the fork: it passes it to `HarnessAgent.createSession({
sandboxSession })` and destroys it itself (`destroy()` = stop + delete). Forks are
created with `persistent: false` because `@vercel/sandbox` sandboxes are
*"persistent by default: the filesystem is snapshotted when a sandbox stops"*;
a persistent fork would leave a multi-GB snapshot behind on every run (observed
live under the old provider: 4 orphans across one E2E session). A failed start
destroys what it holds, then sweeps the fork by name.

The old provider and `prepareHarnessSandboxTemplate` are no longer used, and
with them went the in-memory snapshot-id cache that made
`keepLastSnapshots: { count: 2 }` necessary: each template now holds exactly one
snapshot.

## The three sweeps (backstops, all fail-soft)

Implemented in [`agent/lib/template-sweep.ts`](../agent/lib/template-sweep.ts):

1. **`sweepSessionSnapshots(sessionId)`** — after every run AND on a failed
   start. Deletes by **exact name** (`ai-sdk-harness-session-<sessionId>`) only.
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
stays small, the template snapshot keeps being used (its TTL counts from the last
use, so it never reaches its 7-day expiration, which would force the next real run
to pay a cold rebuild), and the sweeps run daily. The warm builds the template if
needed, then creates one fork from it and destroys it right away.

## Steady-state inventory (what "healthy" looks like)

Check the Vercel dashboard (Sandboxes) after a few days of operation. Healthy is
exactly:

- **1** harness template sandbox + **1** template snapshot;
- eve channel: per-session sandboxes and snapshots plus eve's build-time template
  snapshot, all eve-managed and expiring per `SANDBOX_SNAPSHOT_EXPIRATION_MS`
  (7 d default);
- zero fork snapshots (forks are non-persistent);
- **nothing else.**

Anything beyond this inventory is a leak — find which of the mechanisms
(non-persistent forks, explicit fork destroy, sweeps) missed it. Backstop for
everything: the 7-day `snapshotExpiration` means leaks self-heal within a week even
if every sweep fails.

## Cost quick reference

- Fork boot from a warm template: seconds. Cold template build: minutes — which is
  why warming is out-of-band ([docs/05-dev-agent.md](05-dev-agent.md) §Time budget).
- Platform step retries on a dirty kill: up to 3 × fresh 8-vCPU sandbox — the most
  expensive failure mode; the 700s self-budget exists to make it unreachable.
- Session compute: an eve session sandbox runs until its 30-minute lifetime
  (`SANDBOX_TIMEOUT_MS`) ends, then stops and resumes on the next access; a
  harness fork dies with its run.

## Verification

- `pnpm test` — `sandbox-config.test.ts`, `dev-agent.test.ts` and
  `template-sweep.test.ts` cover the env guards, the fork create options and the
  sweep-selection logic.
- Trigger `warm_sandbox` twice in a row; the second call must be fast
  (`warmed: true`, no template rebuild) and the sweep summary in the log must
  report nothing unexpectedly swept.
- Bump `RECIPE_VERSION`, warm again: exactly one new template appears and the
  stale one (plus its snapshot) is swept.
- Run one real capability, wait ~30 min, then audit the sandbox/snapshot inventory
  against the steady-state list above. Zero fork snapshots is the expected result.

Next: [docs/07-ops.md](07-ops.md) — env vars, CI, and the external health check.
