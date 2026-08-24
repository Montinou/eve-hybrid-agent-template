import { Sandbox, Snapshot } from "@vercel/sandbox";

// Lifecycle care for EVE'S OWN sandbox template — the second, until now
// unattended, sandbox lifecycle in this app.
//
// Background (production incident, 2026-08-24: an agent ran 12 days blind
// before anyone noticed): an app built on this pattern has
// two independent sandbox lifecycles (see docs/06-sandbox-lifecycle.md). The harness template (the dev-agent's
// world) is kept alive by warmQaSandboxTemplate() on a daily schedule. Eve's
// OWN sandbox — the one backing the GitHub channel's repo checkout and the
// read_file/grep/glob tools your orchestrator depends on — had nothing
// equivalent, and it dies in a way nothing recovers from:
//
//   1. Eve provisions its template ONLY at build time
//      (eve/dist/src/internal/nitro/host/vercel-build-prewarm.js).
//   2. The template's snapshot carries `snapshotExpiration` from
//      defaultBackend's create options (SANDBOX_SNAPSHOT_EXPIRATION_MS, set
//      to 24h in production). Once it expires, the sandbox record survives
//      as `stopped` with a `currentSnapshotId` pointing at a deleted
//      snapshot, and resuming it returns HTTP 410.
//   3. Eve's own repair path — re-prewarm the template and retry — is gated
//      on `compiledArtifactsSource.kind === "disk"`
//      (eve/dist/src/execution/sandbox/ensure.js,
//      createBackendHandleWithPrewarmRetry). On a Vercel deployment the kind
//      is never "disk", so the SandboxTemplateNotProvisionedError is
//      rethrown and EVERY later session creation fails until someone
//      redeploys.
//
// Observed live: template snapshots minted by the 2026-08-11 builds expired
// on 2026-08-12, and from 2026-08-13 to 2026-08-24 not a single sandbox was
// created. Every turn in that window reported "no repository checkout
// available (provisioning error)" and degraded to working without one — the
// honest degradation worked, the sandbox never came back.
//
// So this module gives eve's template the same treatment the harness
// template already gets:
//   - RENEW: resume + stop the current template before its snapshot expires,
//     which mints a fresh snapshot and moves the expiry out again.
//   - REBUILD: when the snapshot is already gone (410 / missing), fire a
//     Vercel Deploy Hook — a build is the ONLY supported way to reprovision
//     an eve template in production.
//   - SWEEP: delete prior-identity templates (every deploy that changes the
//     compiled source graph mints a new `eve-sbx-tpl-<scope>-<versionHash>`)
//     and dead session records.
//
// Why dead SESSION records must be deleted, not just left alone: eve's
// ensureSession() looks the session sandbox up BY NAME and, when the record
// exists, hands it back without checking whether it can still resume
// (eve/dist/src/execution/sandbox/bindings/vercel.js). A session whose
// snapshot expired therefore 410s forever. Deleting the record makes the
// next turn recreate that session from the template instead — the record is
// the only thing standing between a dead session and a working one.

/**
 * Eve's sandbox naming, from eve/dist/src/runtime/sandbox/keys.js:
 *   template: `eve-sbx-tpl-<backend>-<scope16>-<versionHash20>`
 *   session:  `eve-sbx-ses-<backend>-<scope16>-<hash12>-<sessionId>-<nodeId>`
 * where `scope` hashes the Vercel project id and `versionHash` covers the
 * compiled source graph + seed files + revalidationKey.
 *
 * These are internal to eve and not exported, so — exactly like
 * template-sweep.ts's HARNESS_* prefixes — they are replicated literally and
 * are fragile against an upstream rename. If this module suddenly reports
 * "no eve template found" after an eve bump, re-verify these two strings
 * first. The failure mode is fail-safe: no match means no sweep and no
 * renewal, never a wrong deletion.
 */
export const EVE_TEMPLATE_NAME_PREFIX = "eve-sbx-tpl-";
export const EVE_SESSION_NAME_PREFIX = "eve-sbx-ses-";

/**
 * Target expiration stamped on the eve TEMPLATE's snapshots by this warm:
 * 30 days, the platform's own default
 * (vercel.com/docs/sandbox/concepts/persistent-sandboxes). Per that doc the
 * TTL is "measured from the snapshot's last use. The timer resets each time
 * the snapshot is used" — so under normal traffic a template never expires
 * at all, and this value only has to cover a drought.
 *
 * Deliberately decoupled from SANDBOX_SNAPSHOT_EXPIRATION_MS (which governs
 * per-session continuity snapshots and is intentionally short — a session
 * snapshot is cheap to lose, since a swept session record is recreated from
 * the template). The template is the opposite: losing it costs a full outage
 * that only a redeploy fixes, so it gets the long expiry AND active renewal.
 * Override with EVE_TEMPLATE_SNAPSHOT_EXPIRATION_MS.
 */
const DEFAULT_EVE_TEMPLATE_SNAPSHOT_EXPIRATION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Renew when the current template snapshot has less than this left. Against
 * the 30d target that means a renewal roughly every three weeks, so a warm
 * schedule could miss three weeks of runs before the template is at risk —
 * the 2026-08-24 outage needed only 24h of silence to become permanent.
 *
 * The renewal itself is what makes the long TTL reachable (measured live
 * 2026-08-24): `stop()` does NOT mint a new snapshot for a template — it
 * reuses the existing snapshot id and pushes its expiry out by that
 * SNAPSHOT's own recorded TTL, which was fixed when the snapshot was
 * created. A template whose snapshot was minted by a build running
 * SANDBOX_SNAPSHOT_EXPIRATION_MS=24h therefore keeps renewing in 24h steps
 * forever, no matter what the sandbox record says. Only an explicit
 * `snapshot({ expiration })` produces a snapshot with the TTL we want — see
 * renewEveTemplateSnapshot. Override with EVE_TEMPLATE_RENEW_BELOW_MS.
 */
const DEFAULT_EVE_TEMPLATE_RENEW_BELOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Never sweep an eve sandbox younger than this. A template is created during
 * a build and used by the sessions that follow it; a session record can be
 * minutes old and mid-turn. One hour is the same floor template-sweep.ts
 * uses for the harness estate.
 */
export const MIN_EVE_SWEEP_AGE_MS = 60 * 60 * 1000;

function resolvePositiveMsOverride(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveEveTemplateSnapshotExpirationMs(): number {
  return resolvePositiveMsOverride(
    process.env.EVE_TEMPLATE_SNAPSHOT_EXPIRATION_MS,
    DEFAULT_EVE_TEMPLATE_SNAPSHOT_EXPIRATION_MS,
  );
}

export function resolveEveTemplateRenewBelowMs(): number {
  return resolvePositiveMsOverride(
    process.env.EVE_TEMPLATE_RENEW_BELOW_MS,
    DEFAULT_EVE_TEMPLATE_RENEW_BELOW_MS,
  );
}

/** The subset of `Sandbox.list()`'s item this module reasons about. */
export interface EveSandboxItem {
  name: string;
  status: string;
  createdAt: number;
  currentSnapshotId?: string | undefined;
}

/** What a template's `currentSnapshotId` actually resolves to, once looked up. */
export interface EveSnapshotState {
  /** `created` means alive; anything else (or a failed lookup) is gone. */
  status: string;
  /** undefined = never expires. */
  expiresAt?: number | undefined;
}

export type EveTemplateAction = "skip" | "renew" | "rebuild";

export interface EveTemplateDecision {
  action: EveTemplateAction;
  reason: string;
  /** Milliseconds of snapshot life left, when a live snapshot was found. */
  remainingMs?: number;
}

/**
 * Which template is the CURRENT one: the most recently CREATED
 * `eve-sbx-tpl-*`. Unlike the harness estate (where template-sweep.ts had to
 * fall back to a recipe tag because `updatedAt` never moves), createdAt is
 * exactly right here — eve creates its template during a build and never
 * recreates it afterwards, so the newest one always belongs to the newest
 * build that changed the sandbox definition. A deploy that leaves the
 * definition untouched reuses the existing template and creates nothing, so
 * "newest" stays correct across those too.
 *
 * Bounded worst case: promoting an OLD deployment (a rollback) makes an
 * older template current again while this function still points at the
 * newer one. The cost is one wrongly-renewed template plus one rebuild when
 * the rolled-back one lapses — recoverable, never data loss. Eve's own
 * templates carry no tags to disambiguate with (verified live: `tags={}`),
 * so recency is the only signal available.
 */
export function pickCurrentEveTemplate(
  items: readonly EveSandboxItem[],
): EveSandboxItem | null {
  const templates = items.filter((s) => s.name.startsWith(EVE_TEMPLATE_NAME_PREFIX));
  if (templates.length === 0) return null;
  return templates.reduce((newest, s) => (s.createdAt > newest.createdAt ? s : newest));
}

/**
 * Pure renewal decision for one template, given what its `currentSnapshotId`
 * resolved to. `snapshot: null` means the id was missing or the lookup found
 * nothing — either way the template cannot be resumed and only a build can
 * bring it back.
 */
export function decideEveTemplateRenewal(params: {
  template: EveSandboxItem | null;
  snapshot: EveSnapshotState | null;
  now: number;
  renewBelowMs?: number;
}): EveTemplateDecision {
  const renewBelowMs = params.renewBelowMs ?? resolveEveTemplateRenewBelowMs();
  if (params.template === null) {
    return {
      action: "rebuild",
      reason: "no eve template sandbox exists — only a build can provision one",
    };
  }
  if (params.template.currentSnapshotId === undefined) {
    return {
      action: "rebuild",
      reason: `template "${params.template.name}" has no currentSnapshotId`,
    };
  }
  if (params.snapshot === null || params.snapshot.status !== "created") {
    return {
      action: "rebuild",
      reason:
        `template "${params.template.name}" points at snapshot ` +
        `"${params.template.currentSnapshotId}" which is ` +
        `${params.snapshot === null ? "missing" : params.snapshot.status} — ` +
        `resuming it would 410`,
    };
  }
  if (params.snapshot.expiresAt === undefined) {
    return {
      action: "skip",
      reason: `template snapshot never expires`,
    };
  }
  const remainingMs = params.snapshot.expiresAt - params.now;
  if (remainingMs > renewBelowMs) {
    return {
      action: "skip",
      reason: `template snapshot still has ${Math.round(remainingMs / 3_600_000)}h left`,
      remainingMs,
    };
  }
  return {
    action: "renew",
    reason:
      remainingMs <= 0
        ? `template snapshot expired ${Math.round(-remainingMs / 3_600_000)}h ago`
        : `template snapshot expires in ${Math.round(remainingMs / 3_600_000)}h ` +
          `(below the ${Math.round(renewBelowMs / 3_600_000)}h renewal floor)`,
    remainingMs,
  };
}

export interface EveSweepDecision {
  sweep: EveSandboxItem[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Prior-identity templates: every `eve-sbx-tpl-*` that is not the current
 * one and is older than the age floor. Nothing can resume them (the sessions
 * they seeded were created from their snapshot and carry their own record),
 * so they are pure storage cost — observed live: three orphans from
 * 2026-08-11 still listed on 2026-08-24.
 */
export function decideEveTemplateSweep(params: {
  items: readonly EveSandboxItem[];
  currentName: string | null;
  now: number;
  minAgeMs?: number;
}): EveSweepDecision {
  const minAgeMs = params.minAgeMs ?? MIN_EVE_SWEEP_AGE_MS;
  const sweep: EveSandboxItem[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const item of params.items) {
    if (!item.name.startsWith(EVE_TEMPLATE_NAME_PREFIX)) continue;
    if (params.currentName !== null && item.name === params.currentName) {
      skipped.push({ name: item.name, reason: "current template" });
      continue;
    }
    const ageMs = params.now - item.createdAt;
    if (ageMs < minAgeMs) {
      skipped.push({
        name: item.name,
        reason: `younger than ${Math.round(minAgeMs / 60_000)}min — possible in-flight build`,
      });
      continue;
    }
    sweep.push(item);
  }
  return { sweep, skipped };
}

/** One session record plus whether any of its snapshots is still alive. */
export interface EveSessionState {
  item: EveSandboxItem;
  hasLiveSnapshot: boolean;
}

/**
 * Dead session records: `eve-sbx-ses-*` that are stopped, older than the age
 * floor, and have NO live snapshot left. These are not merely garbage — they
 * are actively harmful, because ensureSession() resolves a session by name
 * and returns the dead record instead of recreating it from the template
 * (see this module's header). Deleting the record is what lets that durable
 * session come back to life on its next turn.
 *
 * A session with a live snapshot is never touched: that snapshot IS eve's
 * continuity for a conversation that may resume days later.
 */
export function decideDeadEveSessionSweep(params: {
  sessions: readonly EveSessionState[];
  now: number;
  minAgeMs?: number;
}): EveSweepDecision {
  const minAgeMs = params.minAgeMs ?? MIN_EVE_SWEEP_AGE_MS;
  const sweep: EveSandboxItem[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const { item, hasLiveSnapshot } of params.sessions) {
    if (!item.name.startsWith(EVE_SESSION_NAME_PREFIX)) continue;
    if (hasLiveSnapshot) {
      skipped.push({ name: item.name, reason: "live continuity snapshot" });
      continue;
    }
    if (item.status === "running" || item.status === "pending" || item.status === "snapshotting") {
      skipped.push({ name: item.name, reason: `status=${item.status}` });
      continue;
    }
    const ageMs = params.now - item.createdAt;
    if (ageMs < minAgeMs) {
      skipped.push({
        name: item.name,
        reason: `younger than ${Math.round(minAgeMs / 60_000)}min — snapshot may still be publishing`,
      });
      continue;
    }
    sweep.push(item);
  }
  return { sweep, skipped };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface EveWarmResult {
  /** True when the template ends this run resumable (skipped or renewed). */
  healthy: boolean;
  action: EveTemplateAction;
  reason: string;
  template: string | null;
  /** Set when `action` was "rebuild": whether the deploy hook actually fired. */
  rebuildTriggered?: boolean;
  deletedTemplates: string[];
  deletedSessions: string[];
  deletedSnapshots: number;
  skipped: Array<{ name: string; reason: string }>;
  errors: string[];
}

/**
 * Every sandbox in the project, unfiltered.
 *
 * `Sandbox.list()`'s `namePrefix` is only valid together with
 * `sortBy: "name"` (persistent-sandboxes doc: "Filter by name prefix
 * (requires sortBy: 'name')"); passing it alone returns HTTP 400 — verified
 * live 2026-08-24. Using it would also cost two listings, one per prefix, so
 * this takes the single unfiltered page and splits it client-side: the
 * project holds a handful of sandboxes, not thousands.
 */
async function listEveSandboxes(
  abortSignal: AbortSignal | undefined,
): Promise<EveSandboxItem[]> {
  const page = await Sandbox.list({
    ...(abortSignal ? { signal: abortSignal } : {}),
  });
  const items: EveSandboxItem[] = [];
  for await (const sandbox of page) {
    items.push({
      name: sandbox.name,
      status: sandbox.status,
      createdAt: sandbox.createdAt,
      currentSnapshotId: sandbox.currentSnapshotId,
    });
  }
  return items;
}

async function readSnapshotState(
  snapshotId: string,
  abortSignal: AbortSignal | undefined,
): Promise<EveSnapshotState | null> {
  try {
    const handle = await Snapshot.get({
      snapshotId,
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    return {
      status: handle.status,
      expiresAt: handle.expiresAt?.getTime(),
    };
  } catch {
    return null;
  }
}

/**
 * Delete every non-deleted snapshot of a sandbox, then the sandbox record.
 * Same two-step as template-sweep.ts's stale sweep: sandbox removal does not
 * reliably cascade to its snapshots. Never throws.
 */
async function deleteSandboxWithSnapshots(
  name: string,
  abortSignal: AbortSignal | undefined,
  errors: string[],
): Promise<{ sandboxDeleted: boolean; snapshotsDeleted: number }> {
  const signalOpt = abortSignal ? { signal: abortSignal } : {};
  let snapshotsDeleted = 0;
  try {
    const page = await Snapshot.list({ name, ...signalOpt });
    for await (const snapshot of page) {
      if (snapshot.status === "deleted") continue;
      try {
        const handle = await Snapshot.get({ snapshotId: snapshot.id, ...signalOpt });
        await handle.delete(signalOpt);
        snapshotsDeleted += 1;
      } catch (error) {
        errors.push(`delete snapshot "${snapshot.id}" of "${name}": ${toErrorMessage(error)}`);
      }
    }
  } catch (error) {
    errors.push(`list snapshots for "${name}": ${toErrorMessage(error)}`);
  }

  try {
    const handle = await Sandbox.get({ name, resume: false, ...signalOpt });
    await handle.delete(signalOpt);
    return { sandboxDeleted: true, snapshotsDeleted };
  } catch (error) {
    errors.push(`delete sandbox "${name}": ${toErrorMessage(error)}`);
    return { sandboxDeleted: false, snapshotsDeleted };
  }
}

/**
 * Give the template a snapshot with the TTL we actually want, and point the
 * template at it.
 *
 * The sequence is the whole point, and every step was forced by a measured
 * behaviour (all verified live 2026-08-24 against @vercel/sandbox 2.x):
 *
 *   1. `update()` first, without resuming — so the retention policy and the
 *      default expiration apply to what follows. `update()` never
 *      auto-resumes (per the persistence doc), which is why it is safe here.
 *   2. A trivial command resumes the session, which is also what refreshes
 *      the CURRENT snapshot's timer ("measured from the snapshot's last
 *      use").
 *   3. `snapshot({ expiration })` mints a NEW snapshot carrying the TTL we
 *      asked for. This is the only way to get one: `stop()` reuses the
 *      existing snapshot and re-applies that snapshot's own recorded TTL, so
 *      a 24h snapshot stays a 24h snapshot forever no matter what the
 *      sandbox record says.
 *   4. `update({ currentSnapshotId })` makes the new snapshot the one eve
 *      resumes from — eve reads exactly this field when creating a session
 *      (readTemplate in its vercel binding).
 *   5. `stop()` releases the VM. Measured: it leaves `currentSnapshotId`
 *      pointing at the snapshot from step 3, it does not overwrite it.
 *
 * `keepLastSnapshots.count` is 2, not the doc's recommended 1: eve caches
 * the template's snapshotId in memory per function instance
 * (`prewarmedTemplates`), so evicting the previous generation the instant a
 * new one appears can pull it out from under an instance that still holds
 * the old id. Two generations give that cache a grace window — the same
 * reasoning the harness provider already uses.
 */
export async function renewEveTemplateSnapshot(params: {
  name: string;
  expirationMs?: number;
  abortSignal?: AbortSignal;
}): Promise<{ renewed: boolean; snapshotId?: string; expiresAt?: number; error?: string }> {
  const signalOpt = params.abortSignal ? { signal: params.abortSignal } : {};
  const expiration = params.expirationMs ?? resolveEveTemplateSnapshotExpirationMs();
  try {
    const sandbox = await Sandbox.get({ name: params.name, resume: false, ...signalOpt });
    await sandbox.update(
      {
        snapshotExpiration: expiration,
        keepLastSnapshots: { count: 2, expiration, deleteEvicted: true },
      },
      signalOpt,
    );
    await sandbox.runCommand({ cmd: "bash", args: ["-lc", "true"], ...signalOpt });

    const snapshot = await sandbox.snapshot({ expiration, ...signalOpt });
    await sandbox.update({ currentSnapshotId: snapshot.snapshotId }, signalOpt);
    await sandbox.stop(signalOpt);

    return {
      renewed: true,
      snapshotId: snapshot.snapshotId,
      ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt.getTime() } : {}),
    };
  } catch (error) {
    return { renewed: false, error: toErrorMessage(error) };
  }
}

/**
 * Fire the Vercel Deploy Hook that rebuilds the app, which reruns
 * `runVercelBuildPrewarm` and provisions a new eve template. This is the
 * ONLY supported repair once the template snapshot is gone: eve's in-process
 * retry is disabled outside `kind === "disk"` (see module header), so no
 * amount of retrying inside the running deployment can bring it back.
 *
 * Configure EVE_DEPLOY_HOOK_URL with a Vercel Deploy Hook for the production
 * branch. Absent, this returns false and the caller reports it — a missing
 * hook must be visible, not silently swallowed.
 */
export async function triggerEveTemplateRebuild(
  abortSignal?: AbortSignal,
): Promise<{ triggered: boolean; detail: string }> {
  const url = process.env.EVE_DEPLOY_HOOK_URL?.trim();
  if (!url) {
    return {
      triggered: false,
      detail: "EVE_DEPLOY_HOOK_URL is not set — cannot rebuild the eve template",
    };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      ...(abortSignal ? { signal: abortSignal } : {}),
    });
    return response.ok
      ? { triggered: true, detail: `deploy hook accepted (HTTP ${response.status})` }
      : { triggered: false, detail: `deploy hook returned HTTP ${response.status}` };
  } catch (error) {
    return { triggered: false, detail: `deploy hook failed: ${toErrorMessage(error)}` };
  }
}

/**
 * The whole eve-side maintenance pass, mirroring what
 * warmQaSandboxTemplate() does for the harness side. Fail-soft throughout:
 * every failure lands in `errors` and this never throws, because it runs
 * from a schedule where a crash would silently skip the rest of the
 * maintenance.
 *
 * `deep` additionally sweeps prior-identity templates and dead session
 * records. Session sweeping is safe to run daily (it only ever deletes
 * records that already cannot resume), but templates are swept on the deep
 * pass so a rollback has a full week of grace before its template is gone.
 */
export async function warmEveSandboxTemplate(params?: {
  abortSignal?: AbortSignal;
  now?: number;
  deep?: boolean;
}): Promise<EveWarmResult> {
  const abortSignal = params?.abortSignal;
  const now = params?.now ?? Date.now();
  const errors: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const deletedTemplates: string[] = [];
  const deletedSessions: string[] = [];
  let deletedSnapshots = 0;

  let all: EveSandboxItem[];
  try {
    all = await listEveSandboxes(abortSignal);
  } catch (error) {
    return {
      healthy: false,
      action: "rebuild",
      reason: `list eve sandboxes failed: ${toErrorMessage(error)}`,
      template: null,
      deletedTemplates,
      deletedSessions,
      deletedSnapshots,
      skipped,
      errors: [`list eve sandboxes failed: ${toErrorMessage(error)}`],
    };
  }

  const templates = all.filter((s) => s.name.startsWith(EVE_TEMPLATE_NAME_PREFIX));
  const sessions = all.filter((s) => s.name.startsWith(EVE_SESSION_NAME_PREFIX));
  const current = pickCurrentEveTemplate(templates);
  const snapshot =
    current?.currentSnapshotId === undefined
      ? null
      : await readSnapshotState(current.currentSnapshotId, abortSignal);
  const decision = decideEveTemplateRenewal({ template: current, snapshot, now });

  let action = decision.action;
  let reason = decision.reason;
  let rebuildTriggered: boolean | undefined;

  if (action === "renew" && current !== null) {
    const renewal = await renewEveTemplateSnapshot({ name: current.name, abortSignal });
    if (!renewal.renewed) {
      // A renewal that fails on a snapshot we believed alive means the
      // snapshot went away underneath us (410) — escalate to a rebuild
      // rather than reporting a healthy template that cannot resume.
      errors.push(`renew "${current.name}" failed: ${renewal.error}`);
      action = "rebuild";
      reason = `${reason}; renewal failed (${renewal.error})`;
    } else {
      const until =
        renewal.expiresAt === undefined
          ? ""
          : ` (valid ${Math.round((renewal.expiresAt - now) / 3_600_000)}h, until ` +
            `${new Date(renewal.expiresAt).toISOString()})`;
      reason = `${reason}; renewed${renewal.snapshotId ? ` ${renewal.snapshotId}` : ""}${until}`;
    }
  }

  if (action === "rebuild") {
    const rebuild = await triggerEveTemplateRebuild(abortSignal);
    rebuildTriggered = rebuild.triggered;
    reason = `${reason}; ${rebuild.detail}`;
    if (!rebuild.triggered) errors.push(rebuild.detail);
  }

  // Dead session records block their durable sessions from ever resuming, so
  // they are collected on every pass, not only the deep one.
  const sessionStates: EveSessionState[] = [];
  for (const item of sessions) {
    const state =
      item.currentSnapshotId === undefined
        ? null
        : await readSnapshotState(item.currentSnapshotId, abortSignal);
    sessionStates.push({ item, hasLiveSnapshot: state?.status === "created" });
  }
  const sessionSweep = decideDeadEveSessionSweep({ sessions: sessionStates, now });
  skipped.push(...sessionSweep.skipped);
  for (const item of sessionSweep.sweep) {
    const result = await deleteSandboxWithSnapshots(item.name, abortSignal, errors);
    deletedSnapshots += result.snapshotsDeleted;
    if (result.sandboxDeleted) deletedSessions.push(item.name);
  }

  if (params?.deep) {
    const templateSweep = decideEveTemplateSweep({
      items: templates,
      currentName: current?.name ?? null,
      now,
    });
    skipped.push(...templateSweep.skipped);
    for (const item of templateSweep.sweep) {
      const result = await deleteSandboxWithSnapshots(item.name, abortSignal, errors);
      deletedSnapshots += result.snapshotsDeleted;
      if (result.sandboxDeleted) deletedTemplates.push(item.name);
    }
  }

  return {
    healthy: action !== "rebuild",
    action,
    reason,
    template: current?.name ?? null,
    ...(rebuildTriggered === undefined ? {} : { rebuildTriggered }),
    deletedTemplates,
    deletedSessions,
    deletedSnapshots,
    skipped,
    errors,
  };
}
