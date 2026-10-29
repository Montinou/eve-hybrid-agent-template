import { createHarnessSandboxTemplate, HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelNetworkSandboxSession } from "@ai-sdk/sandbox-vercel";
import { tool } from "ai";
import { z } from "zod";
import {
  ESTATE_ROOT,
  enabledRepos,
  findEstateRepo,
  sandboxRuntime,
  type EstateRepo,
} from "./estate.ts";
import { githubToken } from "./github-token.ts";
import {
  HARNESS_SESSION_NAME_PREFIX,
  SANDBOX_TAG_KEY,
  SANDBOX_TAG_VALUE,
  sweepOrphanForkSnapshots,
  sweepSessionSnapshots,
  sweepStaleTemplates,
  type TemplateSweepResult,
} from "./template-sweep.ts";

// The dev-agent: real Claude Code (subscription auth) in a Vercel Sandbox
// with the enabled estate cloned to the filesystem. One shared lib powers
// every capability tool; each tool (agent/tools/run_dev_task.ts and any
// domain capabilities you clone from it) is a thin `defineTool` wrapper that
// extracts context, builds a prompt host-side, and calls runDevAgent().
//
// The shipped default access contract is STRICTLY READ-ONLY — the dev-agent
// inspects code and reports a structured result; nothing branches, commits,
// or pushes. See buildInstructions() for the CUSTOMIZE point if a capability
// genuinely needs write access.
//
// TIME MODEL: each eve tool call runs as one Vercel Workflow step capped
// near the plan max (~800s on Pro, 300s on Hobby). The template build must
// therefore happen OUT of band (warm_sandbox tool → daily schedule →
// warmSandboxTemplate), and every run self-limits to
// DEV_AGENT_TIME_BUDGET_MS (default 700s) so it ends cleanly with a partial
// result + diagnostics instead of being killed by the platform (a dirty kill
// loses everything AND retries the step up to 3×, each retry booting a fresh
// 8-vCPU sandbox — the most expensive failure mode in the whole system).
//
// Result channel: the report_result host tool (structured), with the
// DEV_AGENT_RESULT text marker as a legacy fallback. Caching: estate clone +
// deps install in onBootstrap → template snapshot → fork per session;
// onSession = fresh short-lived credentials + base sync + target-branch
// checkout + incremental install + probes. No credentials ever persist in
// the template snapshot.
//
// SANDBOX WIRING (@ai-sdk/sandbox-vercel's createVercelNetworkSandboxSession):
// the harness template (createHarnessSandboxTemplate: the Claude Code bridge
// recipe + onBootstrap) is built once per identity into a snapshot of a
// non-persistent template sandbox, and each run forks a NON-persistent live
// sandbox from it, which this module owns and destroys. Stale prior-identity
// templates (and their snapshots, explicitly — removal does not reliably
// cascade) are swept on every warm; see agent/lib/template-sweep.ts for why
// the sweep's "current" is identified by recency rather than an exact name.
//
// OPERATIONAL NOTE: ANTHROPIC_AUTH_TOKEN (from `claude setup-token`) expires
// ~1 year after issuance. Nothing in this app auto-alerts on approaching
// expiry — put a reminder in your calendar at rotation time.

const RESULT_MARKER = "===DEV_AGENT_RESULT===";

// Repair + pin the TLS trust store before any git network op. The sandbox
// base image has shipped with an unpopulated CA bundle before; without this
// prelude every clone/fetch dies with an SSL verification error.
const CA_PRELUDE =
  `(sudo update-ca-trust 2>/dev/null || true) && ` +
  `CA=""; for c in /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt; do ` +
  `[ -s "$c" ] && CA="$c" && break; done; ` +
  `[ -n "$CA" ] || { echo "NO USABLE CA BUNDLE" >&2; ls -la /etc/pki/tls/certs/ /etc/ssl/certs/ >&2; exit 78; }; ` +
  `git config --global http.sslCAInfo "$CA"`;

// CUSTOMIZE: add domain-specific modes here as you clone run_dev_task into
// domain capabilities (e.g. "review" | "verify" | "test-plan"), and give
// each a MODE line in buildInstructions() below. See docs/05-dev-agent.md.
export type DevAgentMode = "task";

export interface DevAgentResult {
  status: "ok" | "partial" | "failed";
  /** Markdown, ready to embed in a channel/PR comment section. */
  summary: string;
  /** Full report body (markdown). */
  details?: string;
  /** Only populated when status !== "ok". */
  diagnostics?: string;
}

/**
 * Minimal structural view of the harness sandbox session this module needs.
 * The nominal type is `Experimental_SandboxSession` from
 * `@ai-sdk/provider-utils` — a TRANSITIVE dependency that pnpm's strict
 * node_modules layout does not expose for direct import. Declaring the
 * structural subset here keeps the template typecheck-clean without adding
 * the package as a direct dependency; the real session is assignable to this
 * shape by construction.
 */
type SandboxSessionLike = {
  readonly run: (options: {
    command: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }) => PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
};

// ── Pure helpers (unit-testable, no I/O) ──────────────────────────────────

/**
 * Hard upper bound on the dev-agent time budget (ms).
 *
 * The Vercel Workflow step maxDuration is 800s (on Pro; Hobby is 300s). A
 * dirty kill at that boundary triggers up to 3 automatic step retries, each
 * spawning a fresh 8-vCPU sandbox (expensive and wasteful). This clamp
 * ensures the dev-agent always self-terminates cleanly with a partial result
 * BEFORE the platform kill, preserving what has been verified so far in
 * diagnostics and logs.
 *
 * Raising DEV_AGENT_TIME_BUDGET_MS beyond this in the environment is
 * clamped, not honored. If a run genuinely needs more time, restructure:
 * warm more into the template, or split the capability into smaller runs.
 */
export const MAX_DEV_AGENT_TIME_BUDGET_MS = 750_000;

/**
 * Resolve the self-imposed step budget. An explicit positive override wins;
 * otherwise DEV_AGENT_TIME_BUDGET_MS; otherwise 700_000ms. The resolved
 * value is clamped to MAX_DEV_AGENT_TIME_BUDGET_MS.
 */
export function resolveBudgetMs(explicit?: number): number {
  let resolved: number;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    resolved = explicit;
  } else {
    const fromEnv = Number(process.env.DEV_AGENT_TIME_BUDGET_MS);
    resolved = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 700_000;
  }
  return Math.min(resolved, MAX_DEV_AGENT_TIME_BUDGET_MS);
}

/**
 * The sandbox recipe version. Bump it (env var RECIPE_VERSION, or raise the
 * code default) on ANY change to the sandbox recipe — clone/install steps,
 * the CA prelude, provider resources — so the next warm builds a fresh
 * template instead of silently reusing a stale snapshot. The enabled
 * repo+branch set is covered by the bootstrap hash by construction (see
 * bootstrapHash), so estate changes need no manual bump.
 */
export function resolveRecipeVersion(): number {
  const n = Number(process.env.RECIPE_VERSION);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/**
 * Deterministic template-snapshot identity. Covers the enabled repo+branch
 * set AND the recipe version, so either kind of change invalidates the
 * reusable snapshot.
 */
export function bootstrapHash(input: {
  repos: ReadonlyArray<{ repo: string; branch: string }>;
  recipe: number;
}): string {
  const repos = input.repos
    .map((r) => `${r.repo}@${r.branch}`)
    .sort()
    .join(",");
  return `estate-v${input.recipe}:${repos}`;
}

const STATUSES = new Set<DevAgentResult["status"]>(["ok", "partial", "failed"]);

/** Fallback only: parse the legacy DEV_AGENT_RESULT marker from raw text. */
export function parseResultMarker(text: string): DevAgentResult | null {
  const idx = text.lastIndexOf(RESULT_MARKER);
  if (idx < 0) return null;
  try {
    const parsed = JSON.parse(text.slice(idx + RESULT_MARKER.length).trim()) as {
      status?: unknown;
      summary?: unknown;
      details?: unknown;
      diagnostics?: unknown;
    };
    const status: DevAgentResult["status"] = STATUSES.has(
      parsed.status as DevAgentResult["status"],
    )
      ? (parsed.status as DevAgentResult["status"])
      : "failed";
    return {
      status,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      ...(typeof parsed.details === "string" ? { details: parsed.details } : {}),
      ...(typeof parsed.diagnostics === "string"
        ? { diagnostics: parsed.diagnostics }
        : {}),
    };
  } catch {
    return null;
  }
}

// Secret-shaped substrings that must never survive into a diagnostics string
// (which the orchestrator may post into PR comments or channel messages).
// Kept broad on purpose: an Anthropic key, any of the three GitHub token
// shapes, or a Bearer header value.
// CUSTOMIZE: add regexes for any domain-specific credential shapes your
// deployment introduces (internal API key prefixes, etc.).
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /ghs_[A-Za-z0-9]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /github_pat_[A-Za-z0-9_]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
];

/** Replace secret-shaped substrings (API keys, GitHub tokens, Bearer headers) with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, "[REDACTED]"), text);
}

/**
 * Parse the optional DEV_TASK_SECRETS_JSON env var (a JSON object of
 * string→string) into a per-run secrets map for `sessionSecrets`. Fail-soft:
 * anything unparseable, non-object, or empty resolves to `undefined` (the
 * run proceeds without secrets) — a malformed env var must never crash a
 * capability. Non-string values are dropped rather than coerced, so nothing
 * surprising ever reaches the sandbox env.
 */
export function parseDevTaskSecrets(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  // Keys must be env-var-shaped: they travel to the sandbox as a
  // comma-joined list in DEV_AGENT_SECRET_KEYS (buildSessionSecretsCommand)
  // and are resolved via process.env there — a key with a comma (or any
  // non-env character) would corrupt the split and be silently dropped from
  // the written secrets file. Reject it here, at the boundary, instead.
  const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      ENV_KEY.test(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// ── Runtime wiring ─────────────────────────────────────────────────────────

const BOOTSTRAP_HASH = bootstrapHash({
  repos: enabledRepos().map((r) => ({ repo: r.repo, branch: r.defaultBranch })),
  recipe: resolveRecipeVersion(),
});

/**
 * Presence guard for the subscription token.
 *
 * DO NOT "simplify" this by dropping the auth mode in buildHarnessOptions.
 * The tempting premise — "the harness picks ANTHROPIC_AUTH_TOKEN up from the
 * environment on its own" — is FALSE, and it fails in the direction that
 * costs money without ever failing a test:
 * `resolveClaudeCodeEnv` prefers AI Gateway credentials over the env
 * ANTHROPIC_AUTH_TOKEN whenever auth is left at its "auto" default, and on
 * Vercel the OIDC token is always present. The nested agent then runs
 * happily — billed through the Gateway at API prices instead of the
 * subscription you configured. This guard only covers the token being
 * missing entirely; buildHarnessOptions is what pins the mode.
 */
function requireSubscriptionToken(): void {
  if (!process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "Dev-agent has no model credential: set ANTHROPIC_AUTH_TOKEN " +
        "(Claude subscription OAuth token from `claude setup-token`) as a " +
        "Sensitive env var.",
    );
  }
}

/**
 * Pure builder for createClaudeCode's options — exported so the subscription
 * auth mode is pinned by a unit test. A regression here is a silent billing
 * leak, not a visible failure, so it gets a test of its own.
 *
 * `auth: "direct"` means "use the Anthropic credential, never the Gateway":
 * the harness reads ANTHROPIC_AUTH_TOKEN from the environment, and the real
 * token stays on the host (the sandbox gets a placeholder that the host
 * swaps for the real bearer at egress, only toward the Anthropic API).
 *
 * Precedence re-verified by reading `resolveClaudeCodeEnv` in
 * @ai-sdk/harness-claude-code 1.0.42, 1.0.65, 1.0.88 and 1.0.172: with
 * `"direct"` an anthropic branch returns before the gateway env is read,
 * whereas with no explicit auth a truthy `getAiGatewayAuthFromEnv().apiKey`
 * short-circuits to `pickGateway` ahead of the ANTHROPIC_AUTH_TOKEN fallback.
 * Versions up to 1.0.88 took an object here (`{ anthropic: { authToken } }`);
 * 1.0.172 rejects that nested form (an object `auth` must now be a flat
 * string record that replaces the process env), so keep the mode string.
 *
 * The throw guards a second, subtler leak: `pickAnthropic` merges
 * `processEnv.ANTHROPIC_API_KEY` into the sandbox env even when an explicit
 * mode is set, so an API key sitting in the environment silently re-routes
 * billing away from the subscription.
 */
export function buildHarnessOptions(env: NodeJS.ProcessEnv) {
  if (env.ANTHROPIC_AUTH_TOKEN && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL)) {
    throw new Error(
      "Refusing to start the dev-agent: ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL are " +
        "set alongside ANTHROPIC_AUTH_TOKEN. The harness consumes those env " +
        "fallbacks even with an explicit auth mode, silently re-routing billing " +
        "away from the subscription. Unset them.",
    );
  }
  return {
    // Omit `model` entirely when DEV_AGENT_MODEL is unset (Claude Code default).
    ...(env.DEV_AGENT_MODEL ? { model: env.DEV_AGENT_MODEL } : {}),
    thinking: { type: "adaptive" as const },
    maxTurns: 200,
    ...(env.ANTHROPIC_AUTH_TOKEN ? { auth: "direct" as const } : {}),
  };
}

function makeHarness() {
  return createClaudeCode(buildHarnessOptions(process.env));
}

const DEFAULT_TEMPLATE_SNAPSHOT_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long the dev-agent's sandbox TEMPLATE's newest kept snapshot survives
 * before Vercel is allowed to evict it. Distinct from
 * agent/lib/sandbox-config.ts's SANDBOX_SNAPSHOT_EXPIRATION_MS, which
 * governs eve's OWN backend sandbox (a different lifecycle entirely — see
 * agent/sandbox.ts) — this one is scoped only to the harness template. Same
 * positive-override guard pattern as sandbox-config.ts. Default 7 days:
 * expiration is the backstop for ORPHANED template lineages after a
 * bootstrap-hash/recipe bump — same-name lineage pruning is
 * the stale-template sweep's job. The daily warm schedule keeps the live
 * template's snapshot fresh well inside this window.
 */
export function resolveTemplateSnapshotExpirationMs(): number {
  const n = Number(process.env.TEMPLATE_SNAPSHOT_EXPIRATION_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TEMPLATE_SNAPSHOT_EXPIRATION_MS;
}

/**
 * Fork sandbox id for one run: `ai-sdk-harness-session-<sessionId>`. The
 * prefix is what template-sweep.ts's sweepSessionSnapshots and
 * isHarnessTemplateName key on, so the per-run sweeps keep finding forks and
 * the stale-template sweep never mistakes one for a template.
 */
export function devForkSandboxId(sessionId: string): string {
  return `${HARNESS_SESSION_NAME_PREFIX}${sessionId}`;
}

/**
 * Create options for createVercelNetworkSandboxSession, shared by the
 * template it builds and every fork it creates from that template's
 * snapshot (node_modules/@ai-sdk/sandbox-vercel/src/vercel-sandbox.ts).
 *
 * - `persistent: false`: @vercel/sandbox sandboxes are "persistent by
 *   default: the filesystem is snapshotted when a sandbox stops" (its
 *   README). A per-run fork is thrown away, so it must not mint a
 *   multi-GB snapshot on stop/destroy. (The template is created
 *   non-persistent by the package itself; @ai-sdk/sandbox-vercel 1.0.168
 *   passes `persistent` through to forks.)
 * - `snapshotExpiration`: stamped on the template snapshot. The daily warm
 *   forks from it, and a snapshot's TTL counts from its last use, so an
 *   active template never lapses; this is the backstop for orphaned
 *   prior-identity lineages.
 * - The runtime must match the TARGET repos' engines pins, not this agent
 *   app's own node version — see estate.ts's sandboxRuntime().
 * - The claude-code bridge requires at least one exposed TCP port.
 */
export function buildDevSandboxCreateOptions() {
  return {
    runtime: sandboxRuntime(),
    resources: { vcpus: 8 },
    timeout: 45 * 60 * 1000,
    ports: [4000],
    tags: { [SANDBOX_TAG_KEY]: SANDBOX_TAG_VALUE },
    snapshotExpiration: resolveTemplateSnapshotExpirationMs(),
    persistent: false,
  };
}

/**
 * A fork for one sandbox id, created from the harness template (built from
 * the agent's harness bootstrap recipe + sandboxConfig, so its identity
 * changes exactly when the recipe or the enabled estate changes). The
 * caller owns the returned session and must destroy it.
 */
async function createDevSandboxSession(
  template: Awaited<ReturnType<typeof createHarnessSandboxTemplate>>,
  sandboxId: string,
  abortSignal?: AbortSignal,
) {
  return createVercelNetworkSandboxSession({
    ...buildDevSandboxCreateOptions(),
    ...(template ? { template } : {}),
    sandboxId,
    ...(abortSignal ? { abortSignal } : {}),
  });
}

function installCommand(pm: EstateRepo["packageManager"]): string {
  switch (pm) {
    case "yarn":
      return "corepack enable >/dev/null 2>&1 || true; yarn install --frozen-lockfile";
    case "pnpm":
      return "corepack enable >/dev/null 2>&1 || true; pnpm install --frozen-lockfile";
    case "npm":
      return "npm ci";
  }
}

async function writeGitCredentials(
  session: SandboxSessionLike,
  abortSignal?: AbortSignal,
): Promise<void> {
  const token = await githubToken();
  const result = await session.run({
    command:
      `git config --global credential.helper store && ` +
      `printf 'https://x-access-token:%s@github.com\\n' "$GH_TOKEN" > ~/.git-credentials`,
    env: { GH_TOKEN: token },
    ...(abortSignal ? { abortSignal } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(`git credential setup failed: ${result.stderr.slice(-500)}`);
  }
}

/**
 * Path inside the sandbox where per-session secrets (the parsed
 * DEV_TASK_SECRETS_JSON map) are written. Exported so capability prompt
 * builders (build-task-prompt.ts) can tell the dev-agent WHERE to read
 * credentials from without ever embedding their VALUES in the prompt — the
 * path itself is not a secret.
 */
export const SESSION_SECRETS_PATH = "/tmp/dev-task-secrets.json";

/**
 * Credential-delivery design decision (the most credential-sensitive part of
 * the whole pattern): secret VALUES must never appear in the prompt string,
 * a skill file, a command string, or a log line. Re-verified against
 * @ai-sdk/harness 1.0.168 (`HarnessAgentSandboxConfig`: workDir,
 * bootstrapHash, onBootstrap, onSession) and @ai-sdk/harness-claude-code
 * 1.0.172 (settings: auth, credentialForwarding, env, mcpServers, model,
 * maxTurns, thinking, effort, port, startupTimeoutMs and others). The new
 * `env` setting is harness-wide, fixed when createClaudeCode() runs, and
 * merged into the Claude Code process env in plain text: only the four
 * model-credential variables are brokered through egress placeholders
 * (CLAUDE_CODE_CREDENTIAL_ENVIRONMENT_VARIABLES), so `env` is no safer a
 * channel for arbitrary per-run secrets than a file. So this reuses the
 * exact mechanism `writeGitCredentials` establishes for the GitHub token: a
 * host-side `session.run` call, once per forked session (never in
 * `onBootstrap`, so nothing is ever baked into the reusable template
 * snapshot), whose COMMAND TEXT carries no key name or value — every VALUE
 * travels exclusively through `session.run`'s `env` map. No-op when
 * `secrets` is absent/empty.
 *
 * Built as a separate pure function so it can be exercised by a real
 * `node -e` execution through `/bin/sh` in tests. The command text must
 * never contain a key name or a double quote: an earlier revision of the
 * reference interpolated `JSON.stringify(key)` inside a double-quoted shell
 * string, so the shell stripped the inner quotes and node saw a bare
 * identifier → ReferenceError → exit 1 (found live in production E2E). Key
 * names now travel through the env map too (DEV_AGENT_SECRET_KEYS), and the
 * shell layer is a single-quoted string whose embedded JS uses only double
 * quotes.
 */
export function buildSessionSecretsCommand(
  keys: string[],
  path: string = SESSION_SECRETS_PATH,
): { command: string; keysEnv: Record<string, string> } {
  const script =
    "const o = {};" +
    'for (const k of process.env.DEV_AGENT_SECRET_KEYS.split(",")) o[k] = process.env[k];' +
    `require("fs").writeFileSync(${JSON.stringify(path)}, JSON.stringify(o));`;
  return {
    command: `node -e '${script}' && chmod 600 ${path}`,
    keysEnv: { DEV_AGENT_SECRET_KEYS: keys.join(",") },
  };
}

async function writeSessionSecrets(
  session: SandboxSessionLike,
  secrets: Record<string, string> | undefined,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!secrets || Object.keys(secrets).length === 0) return;
  const { command, keysEnv } = buildSessionSecretsCommand(Object.keys(secrets));
  const result = await session.run({
    command,
    env: { ...secrets, ...keysEnv },
    ...(abortSignal ? { abortSignal } : {}),
  });
  if (result.exitCode !== 0) {
    // Deliberately omit stderr here (unlike writeGitCredentials above): this
    // command sits closer to the secret values than a git-credential-helper
    // error does, so the exit code alone is all the diagnostics get.
    throw new Error(`session secrets write failed (exit ${result.exitCode})`);
  }
}

/** target === null → warm-only template build (no head-branch checkout). */
function makeSandboxConfig(
  state: { estate: string },
  target: { repo: EstateRepo; branch: string } | null,
  sessionSecrets?: Record<string, string>,
) {
  const enabled = enabledRepos();
  const runEnv = {
    GIT_TERMINAL_PROMPT: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  } as const;

  return {
    bootstrapHash: BOOTSTRAP_HASH,
    onBootstrap: async ({
      session,
      abortSignal,
    }: {
      session: SandboxSessionLike;
      workDir: string;
      abortSignal?: AbortSignal;
    }) => {
      // Runs ONCE per template identity, then the provider snapshots the
      // filesystem. Everything expensive and repo-generic goes here.
      // Credentials are deleted before the provider snapshots — no secret
      // ever lives in the reusable template.
      await writeGitCredentials(session, abortSignal);
      const cloneAndInstall = enabled
        .map(
          (r) =>
            `git clone --depth 50 --branch ${r.defaultBranch} ` +
            `"https://github.com/${r.repo}.git" "${ESTATE_ROOT}/${r.dir}"` +
            // installDeps=false → clone-only (see EstateRepo.installDeps: a
            // heavy/fragile install here would endanger the SHARED template).
            (r.installDeps
              ? ` && (cd "${ESTATE_ROOT}/${r.dir}" && ${installCommand(r.packageManager)})`
              : ""),
        )
        .join(" && ");
      const result = await session.run({
        command:
          `${CA_PRELUDE} && mkdir -p ${ESTATE_ROOT} && ${cloneAndInstall} && ` +
          `rm -f ~/.git-credentials`,
        env: runEnv,
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (result.exitCode !== 0) {
        throw new Error(`estate bootstrap failed: ${result.stderr.slice(-2000)}`);
      }
    },
    onSession: async ({
      session,
      abortSignal,
    }: {
      session: SandboxSessionLike;
      sessionWorkDir: string;
      abortSignal?: AbortSignal;
    }) => {
      // Per forked session: fresh short-lived token, base sync, head-branch
      // checkout for the turn's target repo + incremental install, probes.
      await writeGitCredentials(session, abortSignal);

      // Per-run secrets (the parsed DEV_TASK_SECRETS_JSON map): only ever
      // set by the caller when the capability needs them; a no-op otherwise.
      // Written fresh per forked session, same as the git token above —
      // never in onBootstrap, so never part of the reusable template
      // snapshot.
      await writeSessionSecrets(session, sessionSecrets, abortSignal);

      // 1) Base freshness: every enabled repo back onto its default branch.
      const baseSync = enabled
        .map(
          (r) =>
            `(cd "${ESTATE_ROOT}/${r.dir}" && git fetch --depth 50 origin ${r.defaultBranch} && ` +
            `git checkout -q ${r.defaultBranch} && git reset --hard origin/${r.defaultBranch})`,
        )
        .join(" && ");

      // 2) Target repo: check out the head branch + incremental install
      //    (skipped for clone-only repos, matching onBootstrap).
      const targetSync = target
        ? ` && (cd "${ESTATE_ROOT}/${target.repo.dir}" && ` +
          `git fetch --depth 50 origin ${target.branch} && ` +
          `git checkout -q ${target.branch} && ` +
          `git reset --hard origin/${target.branch}` +
          (target.repo.installDeps
            ? ` && ${installCommand(target.repo.packageManager)})`
            : `)`)
        : "";

      const result = await session.run({
        command: `${CA_PRELUDE} && ${baseSync}${targetSync}`,
        env: runEnv,
        ...(abortSignal ? { abortSignal } : {}),
      });
      if (result.exitCode !== 0) {
        state.estate = `SYNC FAILED: ${result.stderr.slice(-1500)}`;
        throw new Error(`estate sync failed: ${result.stderr.slice(-2000)}`);
      }

      // 3) Probes: repo SHAs + adapter bridge survival across the fork,
      //    recorded into `state` so diagnostics can show what the sandbox
      //    actually contained without a separate lookup.
      const verify = await session.run({
        command:
          enabled
            .map(
              (r) =>
                `printf '%s@%s ' "${r.dir}" ` +
                `"$(cd "${ESTATE_ROOT}/${r.dir}" && git log -1 --format=%h)"`,
            )
            .join(" && ") +
          ` && printf 'bridge:%s' ` +
          `"$([ -f /tmp/harness/claude-code/bridge.mjs ] && echo present || echo MISSING)"`,
        ...(abortSignal ? { abortSignal } : {}),
      });
      state.estate =
        verify.exitCode === 0
          ? verify.stdout.trim()
          : `VERIFY FAILED: ${verify.stderr.slice(-500)}`;
    },
  };
}

function runDiagnostics(
  finishReason: string,
  state: { estate: string },
  logTail: string[],
): string {
  return (
    `finishReason=${finishReason} · estate=[${state.estate}] · ` +
    `logTail=${JSON.stringify(logTail.slice(-15)).slice(0, 2000)}`
  );
}

/**
 * Merge run diagnostics into a result, stripping diagnostics on success.
 * This is the single point where a result's `diagnostics` is assembled
 * before being returned, so it's also the single point that redacts
 * secret-shaped text — every diagnostics-bearing return in this file funnels
 * through here.
 */
function finalize(base: DevAgentResult, runDiag: string): DevAgentResult {
  if (base.status === "ok") {
    const { diagnostics: _drop, ...rest } = base;
    return rest;
  }
  const merged = [base.diagnostics, runDiag].filter(Boolean).join("\n---\n");
  return { ...base, ...(merged ? { diagnostics: redactSecrets(merged) } : {}) };
}

function errToString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Instructions for the NESTED agent (Claude Code inside the sandbox). Keep
 * this under ~40 lines — the capability prompt carries the specifics; this
 * carries the invariants: identity + sandbox layout, the read-the-code
 * directive, the TIME BUDGET paragraph, the hard access contract, the MODE
 * line, and the REPORTING mandate.
 */
function buildInstructions(
  mode: DevAgentMode,
  budgetMs: number,
  target: EstateRepo,
  branch: string,
): string {
  const budgetMin = Math.round(budgetMs / 60_000);
  // CUSTOMIZE: one line per mode as you add domain capabilities.
  const modeLine: Record<DevAgentMode, string> = {
    task:
      "TASK: complete the task described in the prompt by reading and " +
      "analyzing the code in the estate, and report your findings.",
  };

  // CUSTOMIZE: the identity line and the access contract. The shipped
  // default is STRICTLY READ-ONLY, which is the safe starting point for
  // review/analysis capabilities. If a capability genuinely needs to write
  // (e.g. opening fix PRs), relax this deliberately, scope the GitHub token
  // accordingly, and pair it with branch protection on the target repos.
  return `You are a dev-agent working in an isolated sandbox on behalf of an orchestrating agent.

The enabled repo estate is cloned under ${ESTATE_ROOT}/ (one directory per
repo). The target repo for this turn is "${target.dir}", checked out to the
head branch "${branch}"; other enabled repos sit on their default branch.
Determine what a change implicates by READING CODE — grep/trace across the
estate before concluding. Each repo's own README/CLAUDE.md is on disk and
authoritative for its conventions.

TIME BUDGET: you have a hard ~${budgetMin}-minute budget for the entire session.
Prefer the smallest correct investigation; do not gold-plate. If you cannot
finish, report the highest-value verified portion and say honestly what remains.

READ-ONLY, non-negotiable: never create branches, commit, push, or modify any
file inside ${ESTATE_ROOT}/. This is an analysis pass, not a fix. Scratch files
in /tmp are fine.

MODE — ${modeLine[mode]}

REPORTING (mandatory): when your work is complete — including when you found
nothing actionable — call the report_result tool EXACTLY ONCE with your final
outcome (status, a markdown summary ready to embed in a channel comment,
optional details, and diagnostics when status is not "ok"). A run that ends
without calling report_result is treated as a failure regardless of what you
did. Do not print result JSON as text; use the tool.`;
}

const reportResultSchema = z.object({
  status: z.enum(["ok", "partial", "failed"]),
  summary: z
    .string()
    .min(1)
    .describe("Markdown, ready to embed in a channel/PR comment section."),
  details: z.string().optional().describe("Full report body (markdown)."),
  diagnostics: z
    .string()
    .optional()
    .describe("Operational notes; include when status is not ok."),
});

async function runOnce(params: {
  mode: DevAgentMode;
  prompt: string;
  target: EstateRepo;
  branch: string;
  budgetMs: number;
  sessionSecrets?: Record<string, string>;
}): Promise<DevAgentResult> {
  const { mode, prompt, target, branch, budgetMs, sessionSecrets } = params;

  // Structured result channel: the dev-agent calls this host tool (proxied
  // into Claude Code via the harness's internal MCP server). Never parse
  // free text as the primary channel.
  let reportedResult: DevAgentResult | null = null;
  const reportResultTool = tool({
    description:
      "Report the final outcome of this session. Call EXACTLY ONCE when " +
      "done. status: ok = completed / no blocking findings, partial = " +
      "incomplete, failed = could not complete or a blocking problem was " +
      "found. summary is markdown for a channel comment; include " +
      "diagnostics when status is not ok.",
    inputSchema: reportResultSchema,
    execute: async (input: z.infer<typeof reportResultSchema>) => {
      reportedResult = {
        status: input.status,
        summary: input.summary,
        ...(input.details ? { details: input.details } : {}),
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
      };
      return { recorded: true };
    },
  });
  // Read through a call to defeat TS's closure-blind null narrowing.
  const getReported = () => reportedResult;

  const logTail: string[] = [];
  const pushLog = (line: string) => {
    logTail.push(line.slice(0, 400));
    if (logTail.length > 120) logTail.shift();
  };
  const state = { estate: "onSession did not run" };

  // Self-imposed budget: end cleanly with a partial result before the
  // platform kills the ~800s workflow step (which would lose everything).
  // The SAME signal goes to BOTH createSession and generate.
  const budgetSignal = AbortSignal.timeout(budgetMs);

  const agent = new HarnessAgent({
    harness: makeHarness(),
    // CUSTOMIZE: your agent's id (shows up in harness logs/traces).
    id: "hybrid-dev-agent",
    instructions: buildInstructions(mode, budgetMs, target, branch),
    // Cast: @ai-sdk/harness resolves its own nested copy of `ai`, so its
    // Tool type is structurally identical but nominally distinct from ours.
    // Runtime shape is the same.
    tools: { report_result: reportResultTool as never },
    permissionMode: "allow-all",
    debug: { enabled: true },
    onLog: (event) => {
      try {
        pushLog(JSON.stringify(event));
      } catch {
        pushLog(String(event));
      }
    },
    sandboxConfig: makeSandboxConfig(state, { repo: target, branch }, sessionSecrets),
  });

  // Unique per ATTEMPT: a failed run can orphan a half-created sandbox under
  // its name, and reusing the id then 400s deterministically. The ts36
  // suffix makes every attempt's id fresh; slice(0, 60) respects the
  // platform's name-length limit.
  const sessionId = `dev-${mode}-${target.dir}-${Date.now().toString(36)}`.slice(
    0,
    60,
  );

  // This module owns the fork (it is passed to createSession as an existing
  // sandbox session), so every path below destroys it.
  let sandboxSession: Awaited<ReturnType<typeof createDevSandboxSession>> | undefined;
  let session;
  try {
    sandboxSession = await createDevSandboxSession(
      await agent.getSandboxTemplate(),
      devForkSandboxId(sessionId),
      budgetSignal,
    );
    session = await agent.createSession({
      sessionId,
      sandboxSession,
      abortSignal: budgetSignal,
    });
  } catch (error) {
    // A failed start can leave a half-created fork sandbox under this
    // sessionId that nothing else will ever destroy (e.g. a secrets-write
    // failure leaves the sandbox + a multi-GB snapshot orphaned). Destroy what we hold, then sweep by name;
    // fail-soft by design.
    await Promise.resolve(sandboxSession?.destroy()).catch(() => {});
    await sweepSessionSnapshots(sessionId, { deleteSandbox: true }).catch(() => {});
    return finalize(
      { status: "failed", summary: "Dev-agent could not create its sandbox session." },
      `sessionId=${sessionId} · ${errToString(error)} · ${runDiagnostics(
        "session-create-error",
        state,
        logTail,
      )}`,
    );
  }

  // The actual run, isolated in its own function so the outer try/finally
  // below can guard session.destroy() without losing an already-computed
  // outcome to a cleanup failure.
  const computeOutcome = async (): Promise<DevAgentResult> => {
    let result: { text: string; finishReason?: string; usage?: unknown };
    try {
      result = await agent.generate({ session, prompt, abortSignal: budgetSignal });
    } catch (error) {
      if (budgetSignal.aborted) {
        // Budget hit: return what we know instead of throwing it away.
        const rep = getReported();
        const diag = runDiagnostics("time-budget-abort", state, logTail);
        if (rep) return finalize(rep, diag);
        return finalize(
          {
            status: "partial",
            summary: `Dev-agent hit the ${Math.round(
              budgetMs / 1000,
            )}s step budget before reporting a result.`,
          },
          diag,
        );
      }
      return finalize(
        { status: "failed", summary: "Dev-agent run failed before producing a result." },
        `${errToString(error)} · ${runDiagnostics("run-error", state, logTail)}`,
      );
    }

    const diag = runDiagnostics(
      String(result.finishReason ?? "unknown"),
      state,
      logTail,
    );
    const reported = getReported() ?? parseResultMarker(result.text);
    if (reported) return finalize(reported, diag);
    return finalize(
      {
        status: "failed",
        summary:
          "Dev-agent finished without calling report_result — see diagnostics.",
      },
      diag,
    );
  };

  let outcome!: DevAgentResult;
  try {
    outcome = await computeOutcome();
  } finally {
    // A cleanup failure here must never discard an already-computed good
    // result: swallow it, and only attach a one-line, redacted note when we
    // actually have a result to attach it to.
    // session.destroy() ends the harness runtime only: the fork was passed in
    // as an existing sandbox session, so its lifecycle is ours to end.
    for (const [label, destroy] of [
      ["session.destroy()", () => session.destroy()],
      ["sandbox destroy()", () => sandboxSession!.destroy()],
    ] as const) {
      try {
        await destroy();
      } catch (destroyError) {
        if (outcome) {
          const note = redactSecrets(`${label} failed: ${errToString(destroyError)}`);
          outcome = {
            ...outcome,
            diagnostics: [outcome.diagnostics, note].filter(Boolean).join("\n---\n"),
          };
        }
      }
    }
    // The fork is non-persistent, so destroy() (stop + delete) mints no
    // snapshot. Sweep this fork's name anyway so every run ends at zero
    // leftovers even if destroy() failed (deleteSandbox: the fork may still
    // exist). Then the
    // deferred orphan sweep picks up PRIOR runs' fork snapshots that were
    // still publishing when their own immediate sweep ran (the 1-2 min
    // publish race — see MIN_ORPHAN_SNAPSHOT_AGE_MS). Cost-hygiene only;
    // never affects the outcome.
    await sweepSessionSnapshots(sessionId, { deleteSandbox: true }).catch(() => {});
    await sweepOrphanForkSnapshots().catch(() => {});
  }
  return outcome;
}

/**
 * Options for a dev-agent run. Capability tools build these host-side; see
 * agent/tools/run_dev_task.ts for the canonical thin wrapper.
 */
export interface RunDevAgentOptions {
  mode: DevAgentMode;
  /**
   * The capability prompt (host-built, e.g. via build-task-prompt.ts).
   * MUST NOT contain secrets — see sessionSecrets.
   */
  prompt: string;
  /** Repository full name (or dir); resolved via findEstateRepo. */
  repo: string;
  /** Head branch to check out on the target repo. */
  branch: string;
  budgetMs?: number;
  /**
   * Per-run secret values written host-side into the sandbox (see
   * `writeSessionSecrets`'s header for the mechanism, and
   * `parseDevTaskSecrets` for the DEV_TASK_SECRETS_JSON source). NEVER
   * interpolate these into `prompt`, a skill, or any log/diagnostics string;
   * they only ever travel through this option and the sandbox `env` it
   * flows into.
   */
  sessionSecrets?: Record<string, string>;
}

async function runDevAgentInner(opts: RunDevAgentOptions): Promise<DevAgentResult> {
  const target = findEstateRepo(opts.repo);
  if (!target || !target.enabled) {
    return {
      status: "failed",
      summary: `Repo "${opts.repo}" is not enabled in the estate; skipping the dev-agent run.`,
    };
  }

  try {
    requireSubscriptionToken();
    return await runOnce({
      mode: opts.mode,
      prompt: opts.prompt,
      target,
      branch: opts.branch,
      budgetMs: resolveBudgetMs(opts.budgetMs),
      ...(opts.sessionSecrets ? { sessionSecrets: opts.sessionSecrets } : {}),
    });
  } catch (error) {
    return finalize(
      { status: "failed", summary: "Dev-agent failed before producing a result." },
      errToString(error),
    );
  }
}

/**
 * Run the dev-agent against a repo/branch. Resolves the repo via
 * findEstateRepo; a repo that is unknown or not enabled fails soft (no
 * throw). All errors are caught and returned as a structured `failed` result
 * — this NEVER throws. The orchestrator treats `failed` as data to report,
 * not a reason to stop other capabilities.
 */
export async function runDevAgent(opts: RunDevAgentOptions): Promise<DevAgentResult> {
  return runDevAgentInner(opts);
}

/**
 * Compact one-line audit trail for the Agent Runs log: which template was
 * kept as current, which sandboxes were actually swept (by name, so a
 * mis-sweep is diagnosable from the log alone without a separate Vercel
 * lookup), how many snapshots were deleted, and the skipped/tagged-seen
 * totals for context.
 */
function formatSweepDetail(sweep: TemplateSweepResult): string {
  const sweptNames =
    sweep.deletedSandboxes.length === 0
      ? "none"
      : sweep.deletedSandboxes.length <= 10
        ? sweep.deletedSandboxes.join(", ")
        : `${sweep.deletedSandboxes.slice(0, 10).join(", ")} (+${sweep.deletedSandboxes.length - 10} more)`;
  const parts = [
    `current=${sweep.current ?? "none"}`,
    `swept=[${sweptNames}]`,
    `deletedSnapshots=${sweep.deletedSnapshots}`,
    `skipped=${sweep.skipped.length}`,
    `taggedSeen=${sweep.taggedSeen}`,
  ];
  if (sweep.errors.length > 0) {
    parts.push(`errors=${sweep.errors.length}:[${sweep.errors.slice(0, 3).join("; ")}]`);
  }
  return parts.join(" ");
}

/**
 * Build (or refresh) the sandbox template snapshot out of band, so runs
 * never pay the multi-minute cold boot inside their ~800s step budget. Call
 * after any deploy that changes the sandbox recipe (RECIPE_VERSION / the
 * enabled repo+branch set). Idempotent and fail-soft — never throws.
 *
 * Also sweeps orphaned prior-identity template sandboxes (see
 * agent/lib/template-sweep.ts) once the current template is confirmed warm.
 * The sweep runs OUTSIDE the build's own try/catch and swallows its own
 * errors: a sweep hiccup is cost-hygiene only and must never flip `ready`
 * back to false after the template itself has already built successfully.
 */
export async function warmSandboxTemplate(
  abortSignal?: AbortSignal,
): Promise<{ ready: boolean; detail: string }> {
  const state = { estate: "warm-only" };
  try {
    requireSubscriptionToken();
    // Same harness + bootstrapHash + onBootstrap as a run, so the same
    // template identity. Creating one fork builds the template when it is
    // missing and otherwise "uses" its snapshot, which restarts the
    // snapshot's TTL ("measured from the snapshot's last use"). The fork is
    // destroyed right away; its name is swept like a run's.
    const { onSession: _onSession, ...templateConfig } = makeSandboxConfig(state, null);
    const template = await createHarnessSandboxTemplate({
      harnesses: [makeHarness()],
      sandboxConfig: templateConfig,
    });
    const warmId = `warm-${Date.now().toString(36)}`;
    try {
      const fork = await createDevSandboxSession(template, devForkSandboxId(warmId), abortSignal);
      await Promise.resolve(fork.destroy()).catch(() => {});
    } finally {
      await sweepSessionSnapshots(warmId, { deleteSandbox: true }).catch(() => {});
    }
  } catch (error) {
    return {
      ready: false,
      detail: `${errToString(error)} · estate=[${state.estate}]`,
    };
  }

  let sweepDetail: string;
  try {
    sweepDetail = formatSweepDetail(
      await sweepStaleTemplates({ ...(abortSignal ? { abortSignal } : {}) }),
    );
  } catch (error) {
    // sweepStaleTemplates() is fail-soft internally; this catch is only
    // defense-in-depth against an unexpected throw from the sweep itself.
    sweepDetail = `sweep crashed: ${errToString(error)}`;
  }

  // Belt & braces for the daily maintenance schedule: with the snapshot-free
  // fork teardown the orphan population should stay at zero, but any stray
  // that slipped through (direct-delete fallback path, crash between stop
  // and delete) gets collected here at least once a day.
  let orphanDetail: string;
  try {
    const orphans = await sweepOrphanForkSnapshots({ ...(abortSignal ? { abortSignal } : {}) });
    orphanDetail = `deleted ${orphans.deleted}/${orphans.seen} seen, ${orphans.protectedSessions} sessions protected${
      orphans.errors.length ? `, errors: ${orphans.errors.join("; ")}` : ""
    }`;
  } catch (error) {
    orphanDetail = `orphan sweep crashed: ${errToString(error)}`;
  }

  return {
    ready: true,
    detail: `template warm · estate=[${state.estate}] · sweep=[${sweepDetail}] · orphans=[${orphanDetail}]`,
  };
}
