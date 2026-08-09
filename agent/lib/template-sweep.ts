import { Sandbox, Snapshot } from "@vercel/sandbox";

// Orphaned-template cleanup for the dev-agent's harness sandbox template.
//
// Background: when the dev-agent's bootstrap hash changes (a RECIPE_VERSION
// bump, or enabling a new estate repo), @ai-sdk/harness's
// prepareHarnessSandboxTemplate derives a NEW opaque template sandbox name
// (`ai-sdk-harness-<identity>` — see below) instead of reusing the old one.
// The old named sandbox and its snapshots then orphan forever unless swept:
// `vercel sandbox remove <name>` does not reliably cascade-delete that
// sandbox's own snapshots (observed still `created`, not `deleted`, minutes
// after removal in the reference deployment), so this module explicitly
// deletes snapshots via the SDK before deleting the sandbox itself.
//
// Why "current" is identified by RECENCY, not by an exact name/identity
// match: the harness's real sandbox name is `ai-sdk-harness-<identity>`,
// where `<identity>` is a SHA-256 digest computed by @ai-sdk/harness's
// UNEXPORTED `./internal/sandbox-bootstrap` + `./internal/bootstrap-recipe`
// modules (`@ai-sdk/harness/package.json`'s `exports` map only publishes
// `.`, `./agent`, `./utils`, `./bridge` — no `./internal` subpath, so it
// cannot be deep-imported). That identity also folds in the Claude Code
// adapter's own opaque recipe hash (`harness.getBootstrap()` /
// `hashHarnessBootstrap`, also unexported), which can change independently
// of this app's own bootstrap hash (e.g. an @ai-sdk/harness-claude-code
// bump). Reimplementing that private hashing here would silently drift on
// any upstream change to either package's hashing. It would ALSO be wrong to
// instead force a stable, self-chosen `name` on the template sandbox (via
// VercelSandboxSettings.name) to sidestep this: that name IS the only
// mechanism that invalidates the template when the recipe changes (Vercel's
// `getOrCreate` only runs `onCreate`/the bootstrap recipe on a genuinely NEW
// name — a stable name would silently keep resuming a stale-recipe sandbox
// forever). So: since warmSandboxTemplate() always calls
// prepareHarnessSandboxTemplate() (which creates-or-resumes/touches the
// CURRENT template) immediately before sweepStaleTemplates() runs, "current"
// is identified empirically as the most-recently-updated genuine template
// name among this app's tagged sandboxes — everything else shaped like a
// template is an orphan from a prior identity and gets swept.
//
// Bounded worst-case (M-1): recency is a proxy, not a guarantee. If a
// prior-recipe template is touched more recently than the real current one —
// a manual rollback, a late/duplicate warm run racing this one, or an
// upstream template-name prefix rename (see decideStaleTemplateSweep's M-2
// fallback below) — the genuinely-current template can itself be swept. The
// cost of that misfire is always bounded: one cold re-warm on the next
// warmSandboxTemplate() run. It is never data loss (per-run session forks
// are independent sandboxes, untouched by this sweep) and never an aborted
// run (a missing template just means the next run pays a cold boot instead
// of resuming a warm one).

/** Minimal shape this module needs from `Sandbox.list()`'s per-item data. */
export interface SandboxListItem {
  name: string;
  tags?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/**
 * Literal replication of @ai-sdk/sandbox-vercel's private naming constants
 * (`node_modules/@ai-sdk/sandbox-vercel/src/vercel-sandbox.ts`:
 * `TEMPLATE_NAME_PREFIX = 'ai-sdk-harness'`, `SESSION_NAME_PREFIX =
 * 'ai-sdk-harness-session'`). Not exported by that package either, so this
 * is fragile against an upstream rename — if the sweep silently stops
 * matching any sandbox after a dependency bump, re-verify these two strings
 * first. Last re-verified against @ai-sdk/sandbox-vercel 1.0.64 (both
 * unchanged).
 */
const HARNESS_TEMPLATE_NAME_PREFIX = "ai-sdk-harness-";
const HARNESS_SESSION_NAME_PREFIX = "ai-sdk-harness-session-";

/** True for a genuine template sandbox name, false for a per-run forked session. */
export function isHarnessTemplateName(name: string): boolean {
  return (
    name.startsWith(HARNESS_TEMPLATE_NAME_PREFIX) &&
    !name.startsWith(HARNESS_SESSION_NAME_PREFIX)
  );
}

/**
 * The tag key/value dev-agent.ts's `makeSandboxProvider()` sets on every
 * sandbox this app creates. Tags are what make the sweeps and dashboard
 * filtering possible at all — never remove them.
 */
export const SANDBOX_TAG_KEY = "app";
// CUSTOMIZE: set to your agent's name. Must be unique among the apps that
// share this Vercel project/team, or the sweeps will consider another app's
// sandboxes fair game.
export const SANDBOX_TAG_VALUE = "eve-hybrid-agent";

/**
 * Double-guard floor: never sweep a sandbox younger than this, regardless of
 * whether it looks like a stale template or a lingering fork. Per-run forks
 * are normally deleted (via session.destroy()) within the ~750s time budget,
 * so anything both this-app-tagged AND non-current AND still around an hour
 * later is either a genuinely orphaned template or a crashed run that never
 * reached session.destroy() — either way, safe to sweep.
 */
export const MIN_SWEEP_AGE_MS = 60 * 60 * 1000;

export interface StaleSweepDecision {
  /**
   * The sandbox this sweep treats as current, or null only when NO sandbox
   * carries the app tag at all.
   *
   * Ordinarily this is the genuine template judged current by name + recency
   * (freshest `updatedAt` among sandboxes matching `isHarnessTemplateName`).
   * But if no tagged sandbox matches that name pattern (M-2: see the
   * "prefix-rename survival" note on `decideStaleTemplateSweep` below), this
   * instead falls back to the freshest-`updatedAt` tagged sandbox of ANY
   * name, so the real current template is never swept just because its name
   * stopped matching our hardcoded prefix.
   */
  current: SandboxListItem | null;
  stale: SandboxListItem[];
  skipped: Array<{ name: string; reason: string }>;
  /** Count of sandboxes carrying the app tag (kept + stale + age-skipped). */
  taggedSeen: number;
}

/**
 * Pure decision function (no I/O): given every sandbox tagged with this
 * app's tag, decide which are safe to delete. See this module's header
 * comment for why "current" is recency-based rather than an exact name
 * match.
 *
 * M-2 — prefix-rename survival: `isHarnessTemplateName` matches against a
 * literal-replicated private constant (`HARNESS_TEMPLATE_NAME_PREFIX`, see
 * above) that this module cannot verify stays in sync with
 * `@ai-sdk/sandbox-vercel`'s actual naming. If a future dependency bump
 * renames that prefix, EVERY existing template sandbox — including the one
 * `warmSandboxTemplate()` just created-or-resumed moments before this sweep
 * runs — stops matching in the same release, and the naive read of "no
 * match => no current template => everything tagged is stale" would delete
 * the one sandbox that is actually current. Since recency (not name) is
 * already this module's proxy for "current" (see header comment), the same
 * proxy still works here: when no sandbox matches the name pattern but
 * tagged sandboxes exist, protect the single freshest-`updatedAt` tagged
 * sandbox as presumed-current rather than sweeping it — the warm-touch
 * ordering guarantee still holds even though the name-based identification
 * doesn't.
 */
export function decideStaleTemplateSweep(params: {
  sandboxes: readonly SandboxListItem[];
  now: number;
  minAgeMs?: number;
}): StaleSweepDecision {
  const minAgeMs = params.minAgeMs ?? MIN_SWEEP_AGE_MS;
  const tagged = params.sandboxes.filter(
    (s) => s.tags?.[SANDBOX_TAG_KEY] === SANDBOX_TAG_VALUE,
  );

  const templates = tagged.filter((s) => isHarnessTemplateName(s.name));
  const genuineCurrent =
    templates.length === 0
      ? null
      : templates.reduce((newest, s) => (s.updatedAt > newest.updatedAt ? s : newest));

  // M-2 fallback: no name matched, but something is tagged — protect the
  // freshest-updatedAt tagged sandbox of any name. See the doc comment above
  // for why this is safe (recency, not name, is the real "current" proxy).
  const current =
    genuineCurrent ??
    (tagged.length === 0
      ? null
      : tagged.reduce((newest, s) => (s.updatedAt > newest.updatedAt ? s : newest)));

  const stale: SandboxListItem[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const sandbox of tagged) {
    if (current && sandbox.name === current.name) {
      skipped.push({
        name: sandbox.name,
        reason: genuineCurrent
          ? "current template"
          : "no tagged sandbox name matched the harness template pattern; protecting the freshest-updatedAt tagged sandbox as presumed-current (possible upstream template prefix rename — see decideStaleTemplateSweep's doc comment)",
      });
      continue;
    }
    const ageMs = params.now - sandbox.createdAt;
    if (ageMs < minAgeMs) {
      skipped.push({
        name: sandbox.name,
        reason: `younger than ${minAgeMs}ms (age ${ageMs}ms) — possible in-flight template build or fork`,
      });
      continue;
    }
    stale.push(sandbox);
  }
  return { current, stale, skipped, taggedSeen: tagged.length };
}

export interface TemplateSweepResult {
  /** Name of the sandbox this sweep kept as current (see `StaleSweepDecision.current`), or null if nothing is tagged at all. */
  current: string | null;
  /** Total sandboxes carrying the app tag seen in this listing (kept + stale + age-skipped). */
  taggedSeen: number;
  /** Total snapshots enumerated across every stale sandbox's `Snapshot.list()` (includes already-`deleted` ones this sweep skips deleting). */
  snapshotsSeen: number;
  deletedSandboxes: string[];
  deletedSnapshots: number;
  skipped: Array<{ name: string; reason: string }>;
  errors: string[];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listTaggedSandboxes(
  abortSignal: AbortSignal | undefined,
): Promise<SandboxListItem[]> {
  const page = await Sandbox.list({
    tags: { [SANDBOX_TAG_KEY]: SANDBOX_TAG_VALUE },
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
  const items: SandboxListItem[] = [];
  for await (const sandbox of page) {
    items.push({
      name: sandbox.name,
      tags: sandbox.tags,
      createdAt: sandbox.createdAt,
      updatedAt: sandbox.updatedAt,
    });
  }
  return items;
}

/**
 * Explicitly delete every non-deleted snapshot belonging to a sandbox name —
 * the workaround for sandbox removal not cascade-deleting its own snapshots.
 * Never throws: failures are appended to `errors` and the function returns
 * how many snapshots it did manage to delete.
 */
async function deleteSnapshotsForSandbox(
  sandboxName: string,
  abortSignal: AbortSignal | undefined,
  errors: string[],
): Promise<{ deleted: number; seen: number }> {
  const signalOpt = abortSignal ? { signal: abortSignal } : {};
  let page: Awaited<ReturnType<typeof Snapshot.list>>;
  try {
    page = await Snapshot.list({ name: sandboxName, ...signalOpt });
  } catch (error) {
    errors.push(`list snapshots for "${sandboxName}" failed: ${toErrorMessage(error)}`);
    return { deleted: 0, seen: 0 };
  }

  let deleted = 0;
  let seen = 0;
  for await (const snapshot of page) {
    seen += 1;
    if (snapshot.status === "deleted") continue;
    try {
      const handle = await Snapshot.get({ snapshotId: snapshot.id, ...signalOpt });
      await handle.delete(abortSignal ? { signal: abortSignal } : undefined);
      deleted += 1;
    } catch (error) {
      errors.push(
        `delete snapshot "${snapshot.id}" (sandbox "${sandboxName}") failed: ${toErrorMessage(error)}`,
      );
    }
  }
  return { deleted, seen };
}

/**
 * Per-run fork cleanup: the harness session's `destroy()` is
 * `sandbox.stop()` THEN `sandbox.delete()`
 * (node_modules/@ai-sdk/sandbox-vercel/dist/index.js), and `stop()` always
 * mints a full-size (multi-GB) snapshot that `delete()` does NOT
 * cascade-remove — so every properly-destroyed per-run fork would leak one
 * snapshot (observed live in the reference deployment: 4 orphans across one
 * E2E session) if dev-agent.ts's teardown patch didn't exist. A failed
 * `createSession` leaks the WHOLE stopped fork sandbox plus its snapshot
 * (nothing ever calls destroy on it). This targets exactly one fork by its
 * deterministic sandbox name (`ai-sdk-harness-session-<sessionId>`, the
 * private naming replicated in HARNESS_SESSION_NAME_PREFIX above) — NEVER a
 * broad snapshot listing: eve's own channel/session snapshots share the
 * project and MUST survive their sandbox's idle death for session
 * continuity, so a "delete snapshots whose source sandbox is gone" sweep
 * would break eve. Fail-soft: never throws.
 */
export async function sweepSessionSnapshots(
  sessionId: string,
  options?: { abortSignal?: AbortSignal; deleteSandbox?: boolean },
): Promise<{ deleted: number; seen: number; sandboxDeleted: boolean; errors: string[] }> {
  const errors: string[] = [];
  const name = `${HARNESS_SESSION_NAME_PREFIX}${sessionId}`;
  const { deleted, seen } = await deleteSnapshotsForSandbox(
    name,
    options?.abortSignal,
    errors,
  );

  let sandboxDeleted = false;
  if (options?.deleteSandbox) {
    try {
      const handle = await Sandbox.get({
        name,
        resume: false,
        ...(options?.abortSignal ? { signal: options.abortSignal } : {}),
      });
      await handle.delete(options?.abortSignal ? { signal: options.abortSignal } : undefined);
      sandboxDeleted = true;
    } catch (error) {
      // Expected whenever createSession failed before the fork existed at
      // all — "not found" is success here, anything else is worth a line.
      errors.push(`delete sandbox "${name}" failed: ${toErrorMessage(error)}`);
    }
  }
  return { deleted, seen, sandboxDeleted, errors };
}

/**
 * Snapshots younger than this are never treated as orphans: a multi-GB fork
 * stop-snapshot takes 1-2 minutes to publish (observed live in the reference
 * deployment — `sweepSessionSnapshots` right after destroy() listed zero
 * snapshots, and the fork's snapshot appeared as `created` minutes later),
 * so the just-finished run's own leftover is deliberately left for the NEXT
 * run's orphan sweep (or the 7d expiration backstop) rather than raced here.
 */
export const MIN_ORPHAN_SNAPSHOT_AGE_MS = 30 * 60 * 1000;

/**
 * Deferred cleanup for fork stop-snapshots that outlived their deleted
 * sandbox (the publish race above, plus anything the teardown patch's
 * fallback path minted).
 *
 * Safety model — the ONLY deletion criterion is "the snapshot's source
 * session belongs to NO listed sandbox":
 * - The protection set is built from EVERY sandbox in the project (any tag,
 *   any status — the API lists stopped ones too) and every HISTORICAL
 *   session of each (`listSessions()`, not just `currentSessionId`: a live
 *   template's original stop-snapshot comes from an older session).
 * - eve's own channel/session snapshots are safe by construction: eve keeps
 *   its stopped session sandboxes listed while their continuity snapshots
 *   live, so their sessions are always in the protection set.
 * - FAIL-CLOSED: any failure while building the protection set aborts the
 *   sweep with zero deletions — never delete against a partial set.
 */
export async function sweepOrphanForkSnapshots(options?: {
  abortSignal?: AbortSignal;
  now?: number;
  minAgeMs?: number;
}): Promise<{ deleted: number; seen: number; protectedSessions: number; errors: string[] }> {
  const errors: string[] = [];
  const signalOpt = options?.abortSignal ? { signal: options.abortSignal } : {};
  const now = options?.now ?? Date.now();
  const minAgeMs = options?.minAgeMs ?? MIN_ORPHAN_SNAPSHOT_AGE_MS;
  const failClosed = () => ({
    deleted: 0,
    seen: 0,
    protectedSessions: 0,
    errors,
  });

  const protectedIds = new Set<string>();
  try {
    const page = await Sandbox.list({ ...signalOpt });
    for await (const item of page) {
      if (item.currentSessionId) protectedIds.add(item.currentSessionId);
      const handle = await Sandbox.get({ name: item.name, resume: false, ...signalOpt });
      const sessions = await handle.listSessions({ ...signalOpt });
      for await (const session of sessions) protectedIds.add(session.id);
    }
  } catch (error) {
    errors.push(`orphan sweep protection set failed: ${toErrorMessage(error)}`);
    return failClosed();
  }

  let deleted = 0;
  let seen = 0;
  try {
    const page = await Snapshot.list({ ...signalOpt });
    for await (const snapshot of page) {
      seen += 1;
      if (snapshot.status !== "created") continue;
      if (protectedIds.has(snapshot.sourceSessionId)) continue;
      if (now - snapshot.createdAt < minAgeMs) continue;
      try {
        const handle = await Snapshot.get({ snapshotId: snapshot.id, ...signalOpt });
        await handle.delete(options?.abortSignal ? { signal: options.abortSignal } : undefined);
        deleted += 1;
      } catch (error) {
        errors.push(`delete orphan snapshot "${snapshot.id}" failed: ${toErrorMessage(error)}`);
      }
    }
  } catch (error) {
    errors.push(`list snapshots failed: ${toErrorMessage(error)}`);
  }

  return { deleted, seen, protectedSessions: protectedIds.size, errors };
}

/**
 * List every sandbox carrying this app's tag, decide which are stale
 * (`decideStaleTemplateSweep`), and for each stale sandbox explicitly delete
 * its snapshots before deleting the sandbox itself. Fail-soft by design:
 * EVERY failure (listing, per-sandbox get/delete, per-snapshot
 * list/get/delete) is caught and appended to `errors` — this function never
 * throws. Call only after `prepareHarnessSandboxTemplate()` has
 * created/confirmed the current template for this invocation (see the module
 * header comment for why that ordering matters for identifying "current").
 */
export async function sweepStaleTemplates(params: {
  abortSignal?: AbortSignal;
  now?: number;
  minAgeMs?: number;
}): Promise<TemplateSweepResult> {
  const errors: string[] = [];

  let sandboxes: SandboxListItem[];
  try {
    sandboxes = await listTaggedSandboxes(params.abortSignal);
  } catch (error) {
    errors.push(`list sandboxes failed: ${toErrorMessage(error)}`);
    return {
      current: null,
      taggedSeen: 0,
      snapshotsSeen: 0,
      deletedSandboxes: [],
      deletedSnapshots: 0,
      skipped: [],
      errors,
    };
  }

  const { current, stale, skipped, taggedSeen } = decideStaleTemplateSweep({
    sandboxes,
    now: params.now ?? Date.now(),
    ...(params.minAgeMs !== undefined ? { minAgeMs: params.minAgeMs } : {}),
  });

  const deletedSandboxes: string[] = [];
  let deletedSnapshots = 0;
  let snapshotsSeen = 0;
  for (const sandbox of stale) {
    const snapshotResult = await deleteSnapshotsForSandbox(
      sandbox.name,
      params.abortSignal,
      errors,
    );
    deletedSnapshots += snapshotResult.deleted;
    snapshotsSeen += snapshotResult.seen;
    try {
      const handle = await Sandbox.get({
        name: sandbox.name,
        resume: false,
        ...(params.abortSignal ? { signal: params.abortSignal } : {}),
      });
      await handle.delete(params.abortSignal ? { signal: params.abortSignal } : undefined);
      deletedSandboxes.push(sandbox.name);
    } catch (error) {
      errors.push(`delete sandbox "${sandbox.name}" failed: ${toErrorMessage(error)}`);
    }
  }

  return {
    current: current?.name ?? null,
    taggedSeen,
    snapshotsSeen,
    deletedSandboxes,
    deletedSnapshots,
    skipped,
    errors,
  };
}
