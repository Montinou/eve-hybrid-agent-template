# 02 — Phase 1: Scaffold, run locally, deploy, prove health

Goal of this phase: the template builds, runs locally, deploys to Vercel, and `GET /eve/v1/health` returns 200. **No channel, no dev-agent runs yet** — just a live, healthy skeleton. Each later phase builds on a deployment you can already verify.

Prerequisites: everything in [docs/01-prerequisites.md](01-prerequisites.md) collected.

## 1. Get the code and install

Use this repo as a GitHub template (or clone it), then:

```bash
git clone git@github.com:{{GITHUB_OWNER}}/{{AGENT_NAME}}.git
cd {{AGENT_NAME}}
pnpm install
```

pnpm is not optional here: [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) pins `overrides` for the `ai` package that the harness stack depends on (pnpm 12 ignores `resolutions` in `package.json`), and the lockfile encodes a version set (`eve` + `ai` + `@ai-sdk/harness*` + `@vercel/sandbox`) that is known to work together. Don't regenerate it with another package manager.

pnpm 12 also refuses to install any version published less than 24 hours ago (`minimumReleaseAge`, built-in default 1440 minutes), even from the lockfile. If `pnpm install` fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, never bypass the hold (no `minimumReleaseAgeExclude` list, no lowered `minimumReleaseAge`, nothing committed to get around it), wait until that release is 24 hours old and re-run ([docs/07-ops.md](07-ops.md), "Staying current").

`pnpm-workspace.yaml` holds the pnpm settings that live outside `package.json`: `allowBuilds: { esbuild: false }` (pnpm 12 fails the install on any dependency build script that is not approved, and esbuild's is not needed) and the `ai` override above.

## 2. Orient yourself in the tree

eve is filesystem-first — the layout IS the configuration:

```text
agent/
├── agent.ts            defineAgent + per-turn dynamic model routing
├── instructions.md     the orchestrator system prompt
├── sandbox.ts          eve's OWN channel sandbox (NOT the dev-agent's)
├── channels/github.ts  GitHub App channel + dispatch          (phase 2)
├── channels/eve.ts     standard eve HTTP channel (chat + API) — customize auth
├── skills/             workflow guides, loaded on demand via eve__skill
├── tools/              run_dev_task, warm_sandbox             (phase 4)
├── schedules/          daily template maintenance             (phase 5)
└── lib/                ALL real logic: pure, unit-tested
scripts/                build post-processing, hashing, the orchestrate CLI
evals/                  delegation and routing evals (docs/10-evals.md)
docs/                   you are here
```

Before writing any eve code in later phases, read the bundled framework docs — they are versioned with the installed package and beat memory every time:

```bash
less node_modules/eve/docs/README.md
```

## 3. Local sanity: typecheck, test, dev server

```bash
pnpm typecheck
pnpm test
```

Both must pass on a fresh clone — if they don't, stop and fix your environment before blaming the code. `pnpm test` includes a docs-accuracy test that checks the scripts, paths and versions the docs name, and the environment variable names they use (names with at least one underscore): a whole inline code span (`NAME` or `NAME=value`) and, inside code (fenced blocks and inline spans), a `NAME=` assignment (including `export NAME=`), `vercel env add|rm|update NAME`, `process.env.NAME` / `process.env["NAME"]`, or `$NAME` / `${NAME}`. Each name must appear in `.env.example`, in the non-test code under `agent/`, `scripts/`, `.github/` or `evals/`, or in the test's short allow-list of external names; bare names in prose or diagrams are not checked. The evals are separate: `pnpm eval --list` shows them without running anything, and running them needs a decision described in [docs/10-evals.md](10-evals.md).

For local model calls the loop needs Gateway auth (see [docs/01-prerequisites.md](01-prerequisites.md) §3). Copy [`.env.example`](../.env.example) to `.env.local` and set either `AI_GATEWAY_API_KEY`, or link the project first (step 5) and run `vercel env pull`. Then:

```bash
pnpm dev        # = eve dev: local runtime + interactive terminal UI
```

Type a message in the TUI. The orchestrator model (default `google/gemini-3.1-flash-lite`, override with `ORCHESTRATOR_MODEL`) should answer. Tools that need the sandbox or GitHub context will fail-soft locally — that's expected at this phase.

For scripted verification use the non-interactive mode and the HTTP API:

```bash
npx eve dev --no-ui &
curl -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Hello, who are you?"}'
```

## 4. Why `pnpm build` is NOT just `eve build`

Look at the build script in [`package.json`](../package.json):

```jsonc
"build": "eve build && node scripts/copy-bridge-assets.mjs"
```

**Never run bare `eve build` for a deployment of this template.** Here's why (gotcha #2, found in production):

- The dev-agent runs Claude Code through `@ai-sdk/harness-claude-code`, whose sandbox *bridge* consists of code **plus data files** (`package.json`, `pnpm-lockfile.yaml`, `pnpm-workspace.yaml`, `index.mjs`) that it loads at runtime relative to the bundled module.
- eve's bundler inlines the bridge's **code** but does not copy its **data files**. The bundle builds green, deploys green, and then every dev-agent run dies at runtime with `ENOENT` when the bridge tries to read its assets.
- [`scripts/copy-bridge-assets.mjs`](../scripts/copy-bridge-assets.mjs) fixes this after `eve build`. It finds every bundled module that loads the bridge (each resolves `./bridge/<asset>` against its own directory: `_chunks/` in the current eve build, `_libs/` in older ones) and copies the assets beside it. It must handle **both** output trees, because only one of them actually deploys depending on where the build runs:
  - `.vercel/output/functions/*.func/` — the Vercel Build Output tree, produced on hosted builds (when the `VERCEL` env var is set). The `.func` dir is what becomes `/var/task` at runtime. On hosted builds the script *hard-fails* if this tree exists without a module that loads the bridge — a deployable bundle without bridge assets must never ship.
  - `.output/server/` — the local/self-host Nitro tree from a plain `eve build`; the script fails here too when no module loads the bridge.
- The same pass patches the server function's `maxDuration` to **800** in `.vc-config.json`: eve sets the workflow function to the max but leaves the server function at the 300s default, which would strangle channel-side turns.

Vercel runs `pnpm build` (the whole script) on hosted builds, so as long as you never change that script line, you're covered. If you ever see `ENOENT ... bridge/...` in production logs, someone changed it, or the bundle layout moved in a way the script did not detect.

## 5. Link and deploy

```bash
vercel link          # create/select the {{VERCEL_PROJECT}} project
```

Set the minimum env vars for a healthy deployment (full canon in [`.env.example`](../.env.example); do the complete pass in [docs/07-ops.md](07-ops.md)):

```bash
# Sensitive! The dev-agent's subscription token (used from phase 4, set it now)
vercel env add ANTHROPIC_AUTH_TOKEN production
# Gateway auth: NOTHING to add — OIDC is automatic on Vercel.
```

Deploy:

```bash
vercel deploy --prod
```

Vercel builds take on the order of ~100 seconds — wait for completion before validating (check `vercel inspect` or the dashboard; don't curl a build that hasn't finished).

## 6. Prove health

`GET /eve/v1/health` is **always public** — it deliberately skips route auth, which is what makes it usable for external monitoring later ([docs/07-ops.md](07-ops.md)):

```bash
curl -i https://{{VERCEL_PROJECT}}.vercel.app/eve/v1/health
```

Expect `HTTP/2 200`. If you get anything else:

- **404** — the build didn't produce eve's routes; check the build logs for `eve build` errors.
- **500** — check `vercel logs`; the usual suspect at this phase is a module that throws at import time (e.g. a required env var read eagerly instead of lazily).
- **Deployment protection page (401 HTML)** — Vercel's Deployment Protection intercepts before eve; either disable it for this project or use a protection bypass. Webhooks in phase 2 need this URL reachable too.

You can also drive the *deployed* agent with the same dev TUI:

```bash
npx eve dev https://{{VERCEL_PROJECT}}.vercel.app
```

## Verification

Do not proceed to phase 2 until every box checks:

- [ ] `pnpm typecheck` and `pnpm test` pass locally.
- [ ] `pnpm build` completes and logs `[copy-bridge-assets] bridge assets → ...` for at least one output tree.
- [ ] `pnpm dev` answers a chat message locally (Gateway auth working).
- [ ] `vercel deploy --prod` succeeds; you waited for the build to finish.
- [ ] `curl https://<deployment>/eve/v1/health` returns **200**.
- [ ] `ANTHROPIC_AUTH_TOKEN` is set as a **Sensitive** env var on the Vercel project.

Next: [docs/03-github-channel.md](03-github-channel.md) — wire the GitHub App and deterministic dispatch.
