import {
  HarnessAgent,
  prepareHarnessSandboxTemplate,
} from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
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
// prepareHarnessSandboxTemplate), and every run self-limits to
// DEV_AGENT_TIME_BUDGET_MS (default 700s) so it ends cleanly with a partial
// result + diagnostics instead of being killed by the platform (a dirty kill
// loses everything AND retries the step up to 3×, each retry booting a fresh
// 8-vCPU sandbox — the most expensive failure mode in the whole system).
//
// Result channel: the report_result host tool (structured), with the
// DEV_AGENT_RESULT text marker as a legacy fallback. Caching: estate clone +
// deps install in onBootstrap → provider snapshot → fork per session;
// onSession = fresh short-lived credentials + base sync + target-branch
// checkout + incremental install + probes. No credentials ever persist in
// the template snapshot.
//
// TEMPLATE LIFECYCLE: the persistent template sandbox built by
// warmSandboxTemplate() (1) carries `keepLastSnapshots: {count: 2,
// deleteEvicted: true}` + `snapshotExpiration` so repeated warms don't
// accumulate snapshots, and (2) sweeps orphaned prior-identity template
// sandboxes (and their snapshots, explicitly — CLI/API removal does not
// reliably cascade-delete them) every time it runs. See
// agent/lib/template-sweep.ts for the full design and why the sweep's
// "current" is identified by recency rather than an exact name match.
// Per-run forks are torn down snapshot-free via patchForkSessionTeardown.
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
 * Presence guard for the subscription token. The claude-code harness
 * resolves ANTHROPIC_AUTH_TOKEN from the env automatically and forwards it
 * to the sandbox bridge (verified in @ai-sdk/harness-claude-code:
 * `authToken = explicit?.authToken ?? processEnv.ANTHROPIC_AUTH_TOKEN`), so
 * we pass NO auth block — we only fail loudly here when it is unset.
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

function makeHarness() {
  return createClaudeCode({
    // REQUIRED since @ai-sdk/harness-claude-code >=1.0.42: without an explicit
    // `auth` block, gateway credentials from the env (automatic OIDC on Vercel)
    // WIN over ANTHROPIC_AUTH_TOKEN and Claude Code bills through AI Gateway at
    // API prices instead of the subscription. Do not remove.
    auth: { anthropic: { authToken: process.env.ANTHROPIC_AUTH_TOKEN } },
    // Omit `model` entirely when DEV_AGENT_MODEL is unset (Claude Code default).
    ...(process.env.DEV_AGENT_MODEL ? { model: process.env.DEV_AGENT_MODEL } : {}),
    thinking: { type: "adaptive" },
    maxTurns: 200,
  });
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
 * keepLastSnapshots' job below. The daily warm schedule keeps the live
 * template's snapshot fresh well inside this window.
 */
export function resolveTemplateSnapshotExpirationMs(): number {
  const n = Number(process.env.TEMPLATE_SNAPSHOT_EXPIRATION_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TEMPLATE_SNAPSHOT_EXPIRATION_MS;
}

/** Structural view of the provider session this wrapper needs. */
type ForkSessionLike = {
  destroy?: () => Promise<void>;
  sandbox?: { delete: () => Promise<void> };
};

/**
 * Make per-run fork teardown snapshot-free. The provider's session
 * `destroy()` is `sandbox.stop().catch(...) → sandbox.delete()`
 * (node_modules/@ai-sdk/sandbox-vercel/dist/index.js), and `stop()` always
 * mints a full-size (multi-GB) snapshot that `delete()` does NOT
 * cascade-remove — pure waste for a throwaway fork, which the sweeps in
 * template-sweep.ts then have to chase (including a 1-2 min publish race).
 * Overriding `destroy` to call `sandbox.delete()` directly mints nothing.
 *
 * Scope: ONLY the fork session's destroy. The TEMPLATE snapshot is created
 * inside `provider.createSession` internals (Sandbox.getOrCreate + stop —
 * that stop-snapshot IS the template, wanted) and `resumeSession` is
 * untouched (a resumed session's stop-snapshot is its resume point, wanted
 * for future multi-step continuation). Mutates the freshly-created session
 * in place rather than spreading it, so prototype members survive.
 *
 * Fail-safe: if the direct delete throws (e.g. the platform rejects deleting
 * a running sandbox), fall back to the original destroy — behavior degrades
 * to the stop+delete path with the sweeps as backstop.
 */
export function patchForkSessionTeardown<S>(session: S): S {
  const forkSession = session as ForkSessionLike;
  const originalDestroy = forkSession.destroy?.bind(forkSession);
  const sandbox = forkSession.sandbox;
  if (originalDestroy && sandbox && typeof sandbox.delete === "function") {
    forkSession.destroy = async () => {
      try {
        await sandbox.delete();
      } catch {
        await originalDestroy();
      }
    };
  }
  return session;
}

type DevSandboxProvider = ReturnType<typeof createVercelSandbox>;

function withSnapshotFreeForkTeardown(provider: DevSandboxProvider): DevSandboxProvider {
  const original = provider.createSession.bind(provider);
  (provider as { createSession: DevSandboxProvider["createSession"] }).createSession = (async (
    ...args: Parameters<DevSandboxProvider["createSession"]>
  ) => patchForkSessionTeardown(await original(...args))) as DevSandboxProvider["createSession"];
  return provider;
}

/**
 * Retention (`snapshotExpiration` + `keepLastSnapshots`) is UNCONDITIONAL —
 * on the provider itself, not only on explicit warm calls: the provider's
 * template snapshotId cache is in-memory PER FUNCTION INSTANCE
 * (@ai-sdk/sandbox-vercel's getSnapshotCache), so every Fluid instance that
 * cache-misses re-runs Sandbox.getOrCreate on the persistent template,
 * re-stops it, and mints ANOTHER full-size template snapshot. If only the
 * explicit-warm path carried retention params, implicit warms (the common
 * path — any run on a fresh instance) would leak untended multi-GB snapshots
 * (observed live in the reference deployment: 3 template snapshots minted
 * across 4 runs, one with NO expiration at all — getOrCreate defaults
 * snapshotExpiration to 0/never when unset).
 *
 * `count: 2`, deliberately not 1: eviction fires when a newer same-name
 * snapshot is minted — exactly the moment OTHER warm instances still hold
 * the previous snapshotId in their in-memory cache. count:1 would delete the
 * snapshot under them and poison every subsequent fork on those instances
 * until they recycle; count:2 keeps one grace generation so a cached id
 * survives one re-stop cycle. Never lower this.
 */
function makeSandboxProvider() {
  return withSnapshotFreeForkTeardown(createVercelSandbox({
    // The runtime must match the TARGET repos' engines pins, not this agent
    // app's own node version — see estate.ts's sandboxRuntime().
    runtime: sandboxRuntime(),
    resources: { vcpus: 8 },
    timeout: 45 * 60 * 1000,
    // The claude-code bridge requires at least one exposed TCP port.
    ports: [4000],
    tags: { [SANDBOX_TAG_KEY]: SANDBOX_TAG_VALUE },
    snapshotExpiration: resolveTemplateSnapshotExpirationMs(),
    keepLastSnapshots: { count: 2, deleteEvicted: true },
  }));
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
 * a skill file, a command string, or a log line. The installed harness
 * surface offers no per-session env passthrough into the underlying Claude
 * Code process's own tool executions (verified against
 * @ai-sdk/harness's `HarnessAgentSandboxConfig` — only
 * workDir/bootstrapHash/onBootstrap/onSession — and
 * @ai-sdk/harness-claude-code's settings — only
 * auth/model/maxTurns/thinking/port/startupTimeoutMs). So this reuses the
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
    sandbox: makeSandboxProvider(),
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

  let session;
  try {
    session = await agent.createSession({ sessionId, abortSignal: budgetSignal });
  } catch (error) {
    // A failed createSession can leave a half-created fork sandbox (stopped,
    // with a stop-snapshot) under this sessionId that nothing else will ever
    // destroy — observed live in the reference deployment (a secrets-write
    // failure left sandbox + multi-GB snapshot orphaned). Sweep both;
    // fail-soft by design.
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
    try {
      await session.destroy();
    } catch (destroyError) {
      if (outcome) {
        const note = redactSecrets(`session.destroy() failed: ${errToString(destroyError)}`);
        outcome = {
          ...outcome,
          diagnostics: [outcome.diagnostics, note].filter(Boolean).join("\n---\n"),
        };
      }
    }
    // With the snapshot-free teardown patch, destroy() normally leaves zero
    // trace — but if the patch fell back to stop()+delete(), stop() minted a
    // snapshot the delete does NOT cascade-remove. Sweep this fork's
    // snapshot(s) so every run ends at zero leftovers. deleteSandbox too: if
    // destroy() itself failed, the stopped fork may still exist. Then the
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
    await prepareHarnessSandboxTemplate({
      harness: makeHarness(),
      sandboxProvider: makeSandboxProvider(),
      sandboxConfig: makeSandboxConfig(state, null),
      ...(abortSignal ? { abortSignal } : {}),
    });
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
