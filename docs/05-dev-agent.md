# 05 — The dev-agent: Claude Code nested inside a tool (phase 4)

This is the heart of the pattern and the hard-won part of the reference
implementation. [`agent/lib/dev-agent.ts`](../agent/lib/dev-agent.ts) runs a real
Claude Code CLI — subscription auth via `ANTHROPIC_AUTH_TOKEN` — inside a Vercel
Sandbox, against a pre-cloned checkout of your repo estate. Every capability tool
(`agent/tools/run_dev_task.ts` and the ones you'll clone from it) is a thin wrapper
over this one lib.

Prerequisites: phase 3 complete ([docs/04-orchestrator.md](04-orchestrator.md)).
Read [docs/06-sandbox-lifecycle.md](06-sandbox-lifecycle.md) alongside this — the
template/fork lifecycle described here has cost consequences handled there.

## Anatomy of a run

```ts
const agent = new HarnessAgent({
  harness: createClaudeCode({
    auth: { anthropic: { authToken: process.env.ANTHROPIC_AUTH_TOKEN } },
    ...(process.env.DEV_AGENT_MODEL ? { model: process.env.DEV_AGENT_MODEL } : {}),
    thinking: { type: "adaptive" },
    maxTurns: 200,
  }),
  id: "hybrid-dev-agent",                      // CUSTOMIZE: your agent's id
  instructions: buildInstructions(mode, budgetMs, target, branch),
  tools: { report_result: reportResultTool },  // host tool, proxied via internal MCP
  permissionMode: "allow-all",
  sandbox: makeSandboxProvider(),              // createVercelSandbox(...)
  sandboxConfig: makeSandboxConfig(state, { repo: target, branch }, sessionSecrets),
});
const session = await agent.createSession({ sessionId, abortSignal: budgetSignal });
const result = await agent.generate({ session, prompt, abortSignal: budgetSignal });
```

**The explicit `auth` block is REQUIRED — do not remove it.** Since
`@ai-sdk/harness-claude-code` ≥1.0.42 (precedence re-verified unchanged at
1.0.65), the bridge's auth resolution prefers
**gateway credentials found in the environment** (automatic OIDC on Vercel)
over `ANTHROPIC_AUTH_TOKEN` whenever no explicit `auth` block is passed. On
Vercel that branch always wins, so an auth-less `createClaudeCode` silently
points Claude Code at the AI Gateway and every nested run bills at **API
prices** instead of the subscription — this exact leak burned US$7.79 of Opus
in one week (2026-07-27) before it was caught. The explicit
`auth.anthropic.authToken` forces the subscription branch.

Detection signal: `anthropic/claude-*` rows attributed to your project in the
AI Gateway dashboard after a dev-agent run mean the leak is back —
subscription traffic never appears there at all.

The lib still *guards* the token's presence and fails loudly (with a
structured `failed` result, see below) when it's missing. This is the only
place in the whole system where the subscription token does anything.

## Time budget discipline

Each eve tool call runs as **one Vercel Workflow step**, capped near the plan
maximum (~800s on Pro, 300s on Hobby). The consequences shape everything:

- **Self-terminate before the platform does.** The lib resolves a budget from
  `DEV_AGENT_TIME_BUDGET_MS` (default 700 000 ms) and clamps it to a hard 750 000 ms
  maximum *in code*. An `AbortSignal.timeout(budgetMs)` is passed to **both**
  `createSession` and `generate`. When it fires, the run returns whatever was
  already reported as a `partial` result with diagnostics.
- **Why 700s beats a platform kill.** A dirty kill at the step boundary loses
  *everything* — no partial result, no diagnostics — **and** triggers up to 3
  automatic step retries, each booting a fresh 8-vCPU sandbox. It is the single
  most expensive failure mode in the system. The clamp is not negotiable via env:
  raising `DEV_AGENT_TIME_BUDGET_MS` beyond 750s is clamped, not honored. If a run
  genuinely needs more time, restructure — warm more into the template, or split
  the capability.
- **Tell the model its budget.** The nested-agent instructions include the budget
  ("hard ~N-minute budget; prefer the smallest correct investigation; report the
  highest-value verified portion if you can't finish"). Claude Code respects this
  remarkably well.

## Template → fork lifecycle

The sandbox provider config has two hooks with sharply different lifetimes:

- **`onBootstrap`** — runs once per *template identity*, then the provider
  snapshots the filesystem. Everything expensive and repo-generic goes here:
  install prerequisites, write git credentials, shallow-clone the whole enabled
  estate (`--depth 50`), run each repo's dependency install, then **delete the
  credentials** (`rm -f ~/.git-credentials`) — the snapshot is reusable and
  long-lived, so no secret may ever be baked into it.
- **`onSession`** — runs per forked session, i.e. per run. Everything
  target-specific and credential-bearing: mint a fresh short-lived git token, write
  per-run secrets (see below), sync every estate repo to its default branch, fetch
  and check out the target branch on the target repo, incremental install, cheap
  probes (repo SHAs) recorded into a `state` object that feeds diagnostics.

Template identity = a deterministic hash of `{ repos: enabled repo@branch list,
recipe: RECIPE_VERSION }`. Bump `RECIPE_VERSION` (env, see
[.env.example](../.env.example)) on *any* recipe change; the repo+branch set is
covered by construction, so enabling an estate repo auto-invalidates the template.

A cold template build (CLI install + clones + installs) takes minutes — most of a
step budget — so it must never happen in the request path. It is warmed
out-of-band by the `warm_sandbox` tool
([`agent/tools/warm_sandbox.ts`](../agent/tools/warm_sandbox.ts)) plus the daily
schedule ([`agent/schedules/template-maintenance.md`](../agent/schedules/template-maintenance.md)).
Details and cost hygiene: [docs/06-sandbox-lifecycle.md](06-sandbox-lifecycle.md).

## Secret delivery: env map → tmp file, never prompts

Rules that survived a production incident and a security review in the reference:

1. Secret **values** travel exclusively through `session.run`'s `env` map. Never in
   command text, never in the prompt, never in logs.
2. Even secret key **names** go via env when a script needs them: interpolating
   `JSON.stringify(key)` inside a double-quoted shell string strips the inner
   quotes and the sandbox sees a bare identifier (found in production). The lib
   single-quotes the shell layer; the embedded script uses only double quotes. The
   unit tests execute the built command through a real `/bin/sh` to prove it.
3. Per-run secrets (`DEV_TASK_SECRETS_JSON`, a JSON map) are written in
   `onSession` — never `onBootstrap` — to a `chmod 600` tmp file; prompt builders
   reference the **path** only.
4. Every diagnostics string funnels through one `finalize()` choke point that
   redacts secret-shaped text (`sk-ant-*`, `ghs_/ghp_/github_pat_*`, `Bearer …`)
   before anything can reach a PR comment.
5. Host-only secrets (email keys, ticket-system keys) stay in host tools and never
   enter the sandbox at all. Anything the dev-agent needs from the outside world
   (preview URLs, ticket context) is resolved by the **tool** host-side and embedded
   in the prompt as content — the sandbox has no third-party network access by design.

## Structured, never-throw results

Free text is never the primary result channel. The dev-agent gets one host tool:

```ts
const reportResultSchema = z.object({
  status: z.enum(["ok", "partial", "failed"]),
  summary: z.string().min(1),          // markdown, ready for a PR comment
  details: z.string().optional(),
  diagnostics: z.string().optional(),  // include when status !== ok
});
```

- The instructions mandate: call `report_result` **exactly once**; a run that ends
  without calling it is a failure; never print result JSON as text.
- A legacy fallback parses a `===DEV_AGENT_RESULT===` marker from the final text
  if the tool wasn't called.
- The outer function **never throws**. Every path — unknown repo, missing token,
  `createSession` failure, budget abort, crash — returns a structured
  `failed`/`partial` result with redacted diagnostics. The orchestrator treats
  `failed` as data to report, not a reason to stop other capabilities.
- Session ids are unique per **attempt** (`` `dev-${mode}-${target.dir}-${Date.now().toString(36)}` ``, sliced to 60 chars):
  a failed run can orphan a half-created sandbox under its name, and reusing that
  id 400s deterministically forever. On `createSession` failure the lib sweeps
  that session's sandbox and snapshots immediately, then returns a structured
  failure (gotcha #8).
- Type note: `@ai-sdk/harness` resolves its own nested `ai` copy, so its Tool type
  is nominally distinct — the host tool is cast at the boundary. The `// Cast:`
  comment in the lib explains it.

## The estate registry

[`agent/lib/estate.ts`](../agent/lib/estate.ts) is the generic repo registry: each
entry declares `owner/repo`, default `branch`, sandbox `runtime`, install behavior,
and an `enabled` flag. The dev-agent only clones and operates on enabled repos.

Two gotchas the registry encodes:

- **Runtime matches the TARGET repo, not the agent.** The agent's host runs Node
  24.x; the sandbox `runtime` must match the *estate repo's* engines pin (e.g.
  `node22` for a repo pinning 22.x). One shared template = one runtime; if repos
  diverge, install per-repo Node inside the recipe (gotcha #3).
- **Adding a repo requires installing the GitHub App on it first** — installation
  is per-repo and a missing installation fails *silently* (webhooks just never
  arrive). See [docs/03-github-channel.md](03-github-channel.md) (gotcha #12).
  Enabling a repo also changes the template identity, so the next warm rebuilds
  the template automatically.

## Adding a capability

`run_dev_task` is the pattern to clone. A new capability (`{{DOMAIN_TASK}}`, e.g.
a review, a triage, a docs check) is always the same three pieces:

1. **A prompt builder in `lib/`** — a pure function, cloned from
   [`agent/lib/build-task-prompt.ts`](../agent/lib/build-task-prompt.ts), with its
   own unit tests. It receives host-resolved context (target repo, branch, ticket
   data, URLs) and returns the prompt string. Pure = testable without a sandbox.
2. **A thin `defineTool` wrapper** — cloned from
   [`agent/tools/run_dev_task.ts`](../agent/tools/run_dev_task.ts): extract context
   from `ctx.session.auth.current.attributes`, resolve anything host-side, build the
   prompt, call the shared dev-agent lib, return its structured result.
3. **One line in the orchestrator contract** — the command→tool mapping in
   `agent/instructions.md` and, if it's a new command, the dispatch attribute in
   `agent/lib/dispatch.ts` ([docs/04-orchestrator.md](04-orchestrator.md)).

Never fork `dev-agent.ts` per capability — one shared lib, N thin tools. Modes that
need different sandbox access (read-only vs read-write) are a `mode` parameter into
`buildInstructions`, not a second lib.

## Verification

- `pnpm typecheck && pnpm test` — the lib's pure helpers (budget resolution and
  clamp, bootstrap hash, marker parsing, secret-command construction, estate
  lookups) are all unit-tested without any deploy.
- Deploy (`pnpm build` first — never bare `eve build`, see
  [docs/07-ops.md](07-ops.md)), call `warm_sandbox` once via a probe comment or the
  eve dev UI, confirm it returns `{ ready: true }`.
- Run a real `run_dev_task` probe on a PR of an enabled estate repo. Confirm the
  PR comment carries a structured section with an honest status, and that a
  deliberately-broken run (e.g. point it at a disabled repo) yields a structured
  `failed` — not a thrown error, not a silent stall.
- Grep the run logs for secret values (there must be none) and confirm
  diagnostics show redaction markers where tokens would appear.

Next: [docs/06-sandbox-lifecycle.md](06-sandbox-lifecycle.md) — what the
template/fork machinery costs and how to keep it clean.
