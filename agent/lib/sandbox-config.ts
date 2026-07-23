// Pure, env-driven resolvers for the eve sandbox's lifecycle knobs. Wired
// into agent/sandbox.ts's `defaultBackend({ vercel: { ... } })` call. Split
// out into their own module (rather than computed inline in sandbox.ts)
// because sandbox.ts's top-level body calls defineSandbox/defaultBackend at
// import time, which would run/duplicate that setup on every test import;
// these two functions have no side effects and can be imported and called
// standalone in agent/lib/sandbox-config.test.ts.
//
// NOTE: these knobs govern eve's OWN backend sandbox (the tool-exec
// environment of the orchestrator loop) — a DIFFERENT lifecycle from the
// dev-agent's harness template/fork sandboxes, whose knob is
// TEMPLATE_SNAPSHOT_EXPIRATION_MS in agent/lib/dev-agent.ts. Confusing the
// two lifecycles is the #1 source of mystery sandbox costs; see
// docs/06-sandbox-lifecycle.md.
//
// Guard rationale: the naive `Number(x) || default` pattern already falls
// back for unset, "", and non-numeric overrides — `Number(undefined)`,
// `Number("")`, and `Number("abc")` are `NaN`/`0`/`NaN`, all falsy — and for
// the literal "0" case (also falsy). It does NOT fall back for negative
// numbers on its own: `Number("-1000")` is `-1000`, a truthy value, so plain
// `||` would pass a negative override straight through to the Vercel Sandbox
// create options. Both resolvers below use an explicit
// `Number.isFinite(n) && n > 0` check — the same guard dev-agent.ts's
// `resolveBudgetMs` uses for DEV_AGENT_TIME_BUDGET_MS — so invalid, zero,
// AND negative overrides all fall back to the default alike.

const DEFAULT_SANDBOX_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SANDBOX_SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

function resolvePositiveMsOverride(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * How long the Vercel-backed sandbox VM may sit IDLE before the platform
 * tears it down. Per eve's sandbox docs (node_modules/eve/docs/sandbox.mdx
 * §Lifecycle): "the VM times out after a period of inactivity ... eve
 * preserves the filesystem and resumes the sandbox on the next message as if
 * nothing happened, even days later." This is an INACTIVITY timeout, not a
 * hard kill switch — a running turn keeps resetting it via its own activity,
 * so it never cuts off an in-progress tool call or a long model-reasoning
 * step, only genuine idle time between turns.
 *
 * Default 5 minutes: short enough that a finished turn's sandbox dies
 * quickly instead of burning billed idle compute, long enough to cover the
 * ordinary model-reasoning gaps *between* tool calls within a single active
 * turn (the sandbox sits briefly idle between calls, but the turn itself is
 * still running) without expiring mid-turn. Expiry is cheap either way: the
 * next turn just pays a snapshot-resume, not a full template rebuild.
 * Override with SANDBOX_IDLE_TIMEOUT_MS to tune without a code change.
 */
export function resolveSandboxIdleTimeoutMs(): number {
  return resolvePositiveMsOverride(
    process.env.SANDBOX_IDLE_TIMEOUT_MS,
    DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
  );
}

/**
 * How long an idle-expired sandbox's filesystem snapshot survives before eve
 * gives up resuming it and rebuilds from template instead. Default 7 days:
 * covers a PR's typical active review life (the durable session backing one
 * PR/channel thread) without paying for indefinite retention. Revisit with
 * real usage data once you know actual idle-to-return distributions.
 * Override with SANDBOX_SNAPSHOT_EXPIRATION_MS.
 */
export function resolveSandboxSnapshotExpirationMs(): number {
  return resolvePositiveMsOverride(
    process.env.SANDBOX_SNAPSHOT_EXPIRATION_MS,
    DEFAULT_SANDBOX_SNAPSHOT_EXPIRATION_MS,
  );
}
