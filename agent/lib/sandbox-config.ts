// Pure, env-driven resolvers for the eve sandbox's lifecycle knobs. Wired
// into agent/sandbox.ts's `DefaultSandbox.environment({ vercel: { ... } })`
// call. Split out into their own module (rather than computed inline in
// sandbox.ts) because sandbox.ts's top-level body calls
// DefaultSandbox.environment/defineSandbox at import time, which would
// run/duplicate that setup on every test import; these functions have no
// side effects and can be imported and called standalone in
// agent/lib/sandbox-config.test.ts.
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

/**
 * eve 0.89's own default `timeout` for Vercel session sandboxes
 * (DEFAULT_SANDBOX_TIMEOUT_MS = 18e5 in
 * node_modules/eve/dist/src/execution/sandbox/bindings/vercel.js), and the
 * same 30 minutes @ai-sdk/sandbox-vercel defaults to because "the
 * `@vercel/sandbox` SDK defaults to 5 minutes which is too short for
 * multi-step workflows — the VM expires between steps"
 * (node_modules/@ai-sdk/sandbox-vercel/src/utils.ts).
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SANDBOX_SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The longest single tool call: one Vercel function invocation, whose
 * maxDuration scripts/copy-bridge-assets.mjs sets to 800 seconds. The
 * sandbox lifetime is never resolved below this, so a VM opened for a tool
 * call cannot be terminated while that call is still running.
 */
export const MAX_TOOL_STEP_MS = 800_000;

function parsePositiveMs(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function resolvePositiveMsOverride(raw: string | undefined, fallback: number): number {
  return parsePositiveMs(raw) ?? fallback;
}

/**
 * The Vercel Sandbox `timeout` for eve's session sandboxes. It is a HARD
 * LIFETIME, not an idle timeout: @vercel/sandbox documents it as "Timeout in
 * milliseconds before the sandbox auto-terminates", its README as the
 * sandbox's maximum duration, and `extendTimeout()` as extending "the
 * lifetime of a sandbox". Activity does not reset it, and eve's session
 * handle exposes no `extendTimeout()`.
 *
 * What a termination costs: eve's session sandboxes are persistent, so the
 * next access resumes the saved filesystem (node_modules/eve/docs/sandbox/
 * index.mdx §Lifecycle). Only a command still running at that moment is
 * lost. Hence the floor at MAX_TOOL_STEP_MS, and the 30-minute default,
 * which covers more than two full tool-call steps after the VM starts.
 *
 * Override with SANDBOX_TIMEOUT_MS. The pre-0.89 name SANDBOX_IDLE_TIMEOUT_MS
 * is still accepted as an alias (it never was an idle timeout);
 * SANDBOX_TIMEOUT_MS wins when both are set.
 */
export function resolveSandboxTimeoutMs(): number {
  const resolved =
    parsePositiveMs(process.env.SANDBOX_TIMEOUT_MS) ??
    parsePositiveMs(process.env.SANDBOX_IDLE_TIMEOUT_MS) ??
    DEFAULT_SANDBOX_TIMEOUT_MS;
  return Math.max(resolved, MAX_TOOL_STEP_MS);
}

/**
 * Default expiration of snapshots created for eve's sandboxes
 * (@vercel/sandbox's `snapshotExpiration`, forwarded by eve to the
 * build-time template sandbox and to each session sandbox). Default 7 days:
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
