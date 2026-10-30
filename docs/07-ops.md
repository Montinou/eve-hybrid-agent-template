# 07 — Operations: env vars, CI, health check, probe PR (phase 6)

The final phase turns a working deployment into an *operated* one: environment
variables set correctly in Vercel, CI gates that catch drift before deploy, an
external heartbeat, and one honest end-to-end probe.

Prerequisites: phases 1–5 complete. The full env-var canon lives in
[.env.example](../.env.example) and the table in
[docs/09-customization-checklist.md](09-customization-checklist.md).

## Environment variables in Vercel

Set every secret as **Sensitive** in the Vercel project (Settings → Environment
Variables): `ANTHROPIC_AUTH_TOKEN`, `GITHUB_APP_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET`, `DEV_TASK_SECRETS_JSON`, `RESEND_API_KEY`, and any
`GITHUB_TOKEN` PAT fallback. Sensitive vars are write-only after creation — that's
the point.

Two notes that repeatedly bite:

- `AI_GATEWAY_API_KEY` is usually **unnecessary on Vercel** — the loop bills via
  OIDC automatically. Local dev pulls a token with `vercel env pull` (it lands as
  `VERCEL_OIDC_TOKEN` in `.env.local`; it expires and needs re-pulling).
- `ANTHROPIC_AUTH_TOKEN` (from `claude setup-token`) expires **~1 year** after
  issuance and *nothing alerts on expiry* — the failure mode is every dev-agent
  run turning `failed` with an auth error one day. Record the rotation date in a
  calendar a human actually sees ([docs/01-prerequisites.md](01-prerequisites.md)).

### Vercel CLI gotchas (when setting envs from a terminal or agent)

- In non-interactive/agent contexts `vercel env add` may mark values sensitive by
  default; pass `--no-sensitive` for values that must stay readable (model ids,
  timeouts).
- Targets are comma-separated (`production,preview`), not repeated flags.
- Beware shell word-splitting when piping values — multi-line PEM keys in
  particular. Prefer `vercel env add NAME production < keyfile.pem`. The channel
  code normalizes `\n`-escaped PEMs anyway
  ([`agent/lib/github-token.ts`](../agent/lib/github-token.ts)), but a
  half-pasted key fails in confusing ways.

After changing envs, **redeploy** — env changes don't apply to running deployments.

## CI gates

[.github/workflows/ci.yml](../.github/workflows/ci.yml) runs on every push/PR:

1. `pnpm typecheck` — `lib/` is pure TypeScript, so most of the system is
   verifiable without a deploy.
2. `pnpm test` — the vitest suite (dispatch, model resolution, budget clamp,
   estate, sandbox-config guards, prompt builders, secret-command execution),
   including `agent/lib/removed-apis.test.ts`, which fails on any use of an API
   eve's pre-1.0 cleanup removed, and `agent/lib/docs-accuracy.test.ts`, which
   fails when a doc names a script, path or version that does not match the
   repo, or an environment variable name (one with at least one underscore)
   that is in none of `.env.example`, the non-test code under `agent/`,
   `scripts/`, `.github/` and `evals/`, or the test's short allow-list of
   external names. It reads names written as a whole inline code span (`NAME`
   or `NAME=value`) and, inside code (fenced blocks and inline spans), as a
   `NAME=` assignment (including `export NAME=`),
   `vercel env add|rm|update NAME`, `process.env.NAME` /
   `process.env["NAME"]`, or `$NAME` / `${NAME}`; bare names in prose are not
   checked.
3. `pnpm build` — must succeed **and print no deprecation notice**. The CI step
   captures the build output and fails when `grep -i deprecat` matches it.
4. **Instructions-hash drift gate** — `node scripts/hash-instructions.mjs --check`
   fails when [`agent/instructions.md`](../agent/instructions.md) and its committed
   hash ([`agent/lib/instructions-hash.ts`](../agent/lib/instructions-hash.ts)) are
   out of sync. This catches the classic failure of editing the prompt (or its
   generated snapshot) in one place only. If you edit the prompt, re-run
   `pnpm hash-instructions` and commit both files.

Evals are not a CI gate: they run against a live model and cost money, so run
them on demand (`pnpm eval`, [docs/10-evals.md](10-evals.md)).

The deploy itself is `pnpm build && vercel deploy --prod` — **never bare
`eve build`**: the bundler inlines the claude-code bridge's code but not its data
files, so an unpatched bundle fails every dev-agent call with ENOENT at runtime
(gotcha #2). `scripts/copy-bridge-assets.mjs` copies the bridge into both output
trees and patches the server function's `maxDuration` to 800 in the same pass. The
`build` script in `package.json` already chains it; CI and any deploy pipeline must
go through that script.

## Staying current

eve is pre-1.0 and ships breaking changes, so a template that is not updated
stops building. Four things keep it current:

- **A weekly update PR.** [.github/dependabot.yml](../.github/dependabot.yml)
  opens one grouped PR per week for npm (one group holds every dependency, so
  eve, `ai`, `@ai-sdk/*` and `@vercel/*` always move together) and one for
  GitHub Actions.
- **One rule on that PR:** run `pnpm typecheck`, `pnpm test` and `pnpm build`,
  and merge only when all three pass with no deprecation output (CI enforces
  the same). When the PR bumps eve, read the migration notes in
  `node_modules/eve/docs/guides/` for the new version before fixing failures.
- **One manual step Dependabot does not do:** `pnpm-workspace.yaml` pins the
  `ai` package under `overrides` (`ai: ^7.0.157`), next to the `ai` dependency
  in `package.json`. When the PR changes the `ai` range, change the override to
  the same range in the same PR; otherwise the override keeps forcing the old
  range on every package that depends on `ai`. Dependabot edits `package.json`
  and the lockfile only.
- **The pnpm release-age hold.** pnpm 12 refuses to install a package version
  published less than 24 hours ago: the setting is `minimumReleaseAge`, its
  built-in default is 1440 minutes (pnpm 12.16.1's changelog; `pnpm config get`
  prints nothing for a built-in default), and it is checked against the
  lockfile too. `pnpm install --frozen-lockfile` then fails with
  `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` and names the offending versions.
  It is a supply-chain control (a freshly published release gets a day to be
  noticed and pulled if it is malicious or broken). Never bypass it: no
  `minimumReleaseAgeExclude` list, no lowered `minimumReleaseAge` in
  `pnpm-workspace.yaml`, no command-line override, and nothing committed to get
  around it. Wait until the release is 24 hours old, then re-run CI; never merge
  a red PR around it. The weekly Dependabot PR hits this
  whenever it picks up a release from the last day, so
  [.github/dependabot.yml](../.github/dependabot.yml) sets
  `cooldown: default-days: 1` for npm (GitHub's `cooldown` option applies to
  version updates, not security updates), which keeps its PRs from proposing
  a version younger than a day. Known case at the time of writing: the
  lockfile holds `eve@0.90.0` (published 2026-10-29T19:24Z) and several
  `ai`/`@ai-sdk/*` entries (published 2026-10-29T17:08Z), so a fresh
  `pnpm install --frozen-lockfile` fails until about 2026-10-30T19:25Z; after
  that it passes with no change. Until then, local installs and CI wait too.

A doc or code comment that names a version is fixed in the same PR as the bump
that makes it stale. `agent/lib/docs-accuracy.test.ts` (part of `pnpm test`, so
part of CI) enforces this for the docs: it fails when a doc names a pnpm
script, a repo path, an environment variable (in the forms listed in item 2
above) or an eve, `ai`, `@ai-sdk/*` or pnpm version that does not match the
repo; the `ai: ^x.y.z` form is compared with the `overrides` entry in
`pnpm-workspace.yaml`, other ranges with `package.json`. It does not read
code comments, so after a bump also `grep -rn` the old version under `agent/`, `evals/`,
`scripts/` and `.github/`. After an eve or
`@ai-sdk/harness-claude-code` bump also do the preview-deploy check in
[Verification](#verification).

## Template vs deployed agent

The two probes below ship as scaffolding for the repo of a DEPLOYED agent, and
they are **inert until `EVE_HEALTH_URL` is set**. Each workflow's job carries
a job-level `if:` that tests `vars.EVE_HEALTH_URL`, so on the template itself and on a fresh
copy of it (no agent deployed, no variable) GitHub skips the job instead of
running it: nothing probes, nothing alerts, and the run is skipped rather than
failed. A scheduled run that fails is what makes GitHub email the repo owner;
a skipped job is not a failure, so the unconfigured repo stays silent.

To turn them on, set the repository **variable** `EVE_HEALTH_URL` on the repo of
the deployed agent (Settings → Secrets and variables → Actions), plus the other
variables and secrets of each probe described below. `EVE_HEALTH_URL` is the one
switch for both workflows: setting it enables `health-check.yml` and
`sandbox-health.yml` together. Once it is set you have opted in, so a missing
`AGENT_API_KEY` makes `sandbox-health.yml` fail loudly (it is not skipped).
Set `EVE_HEALTH_URL` when you do the ops phase, after the `AGENT_API_KEY` bearer
token exists (see "Second probe" below); then dispatch each workflow once with
`workflow_dispatch` and confirm the first run is green. Unsetting the variable
turns both back off. `agent/lib/workflows.test.ts` pins this: every job of a
scheduled workflow must be gated on `EVE_HEALTH_URL`, and the `ci.yml`
workflow, which runs on `pull_request` and `push`, must need no secret or
variable to pass on a fresh copy.

## External health check

[.github/workflows/health-check.yml](../.github/workflows/health-check.yml) is a
GitHub Actions cron (every 30 min) that curls `GET /eve/v1/health` on your
production domain — the endpoint is always public and skips route auth — retries
3× 30s apart, and on failure emails via Resend.

Why external, and why this belongs in a *different* system than the agent: **a dead
agent cannot self-report.** Any in-agent heartbeat (a schedule that posts "I'm
alive") fails silently in exactly the scenarios you built it for — a broken deploy,
an exhausted quota, a misconfigured route. The probe must live outside the failure
domain. GitHub Actions cron + one curl is the cheapest thing that satisfies that.

Setup (this is what turns the probe on, see
[Template vs deployed agent](#template-vs-deployed-agent)): in the agent repo's
GitHub settings, add the repository **variable**
`EVE_HEALTH_URL` (e.g. `https://{{VERCEL_PROJECT}}.vercel.app/eve/v1/health`),
variables `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO`, and the **secret**
`RESEND_API_KEY`. Without the Resend pieces the ping still runs; only the alert
step is inert. (Email alerts are optional — see
[docs/08-extensions.md](08-extensions.md).)

## Second probe: is the SANDBOX usable?

`/eve/v1/health` returning 200 does not mean the agent can work. It proves the
deployment boots and serves — nothing about whether it can open a sandbox. The
two failure modes look identical from outside and are completely different
inside, and the sandbox one is the quiet one: an agent can go days unable to
create a single sandbox while every health ping stays green, because the tools
needing a checkout degrade honestly instead of erroring.

[`.github/workflows/sandbox-health.yml`](../.github/workflows/sandbox-health.yml)
closes that gap. Like the health check it is inert until `EVE_HEALTH_URL` is
set. Once a day it asks the agent to run `echo SANDBOX_OK` through
its built-in `bash` tool and report one machine-readable line. That opens a
sandbox for the probe's new session, created from eve's build-time template
snapshot — exactly the path that fails once that snapshot has expired
(*"The runtime never recreates a template. Run `eve build` again and deploy its
output"*, eve's `sandbox/troubleshooting.mdx`). It alerts when the answer is
missing *or* unhealthy — "could not confirm" is not "fine" — and the repair is a
redeploy ([docs/06-sandbox-lifecycle.md](06-sandbox-lifecycle.md)). It needs one
extra secret beyond the health check's: `AGENT_API_KEY`, a bearer token that the
agent's eve channel accepts. As shipped, `agent/channels/eve.ts` admits only
`vercelOidc()` and `localDev()`, neither of which accepts such a token, so until
you add an API-key verifier there the probe is answered `401` and the workflow
fails (see the header of `sandbox-health.yml` and `scripts/orchestrate.mjs`,
which sends it as `EVE_TOKEN`). That is a change to the channel's auth, so it
is the owner's decision. The probe is external for the same reason as the health
check: an agent that cannot open a sandbox cannot report that it cannot.

## Validate a branch against its preview before merging

Preview deployments sit behind Vercel Deployment Protection, so a plain `curl`
gets a login page. `scripts/orchestrate.mjs` reads **`EVE_BYPASS_TOKEN`** (a
Protection Bypass for Automation secret, generated by `vercel curl` or in
Project → Settings → Deployment Protection) and sends it as
`x-vercel-protection-bypass` on every request:

```bash
EVE_BYPASS_TOKEN=… EVE_TOKEN=$AGENT_API_KEY \
  EVE_AGENT_URL=https://<branch-preview>.vercel.app \
  node scripts/orchestrate.mjs "Call the warm_sandbox tool once and report the result."
```

This is worth doing for any dependency bump that changes `BOOTSTRAP_HASH`,
because that forces a template rebuild and a rebuild exercises the one path
unit tests cannot: cloning the estate and installing its dependencies. A real
upgrade validated this way surfaced a failure that had nothing to do with the
upgrade — a target repo could no longer `yarn install`, because a package it
depended on had been unpublished from npm days earlier. Merging first would
have left the dev-agent with no template at all.

## The E2E probe PR — expect it to find real bugs

The last step of setup is not a checklist item, it's a **discovery pass**: open a
real PR on an enabled estate repo, post the mention command
(`@{{BOT_NAME}} run`), and let every capability execute end-to-end through the
real channel, real dispatch, real sandbox, real repos.

Set expectations correctly: **the probe WILL find real bugs.** The first E2E
probe typically surfaces a few — for example a sandbox runtime
mismatch (template built for the wrong Node major), a shell-quoting bug in secret
delivery (JSON keys losing their quotes inside a double-quoted string), and a wrong
preview-URL derivation. None of these are catchable by unit tests or a health ping;
all of them are one-line fixes once the probe surfaces them. Budget an iteration
loop (fix → `pnpm build` → deploy → re-probe), not a single victory lap.

What to check on the probe result:

- The PR comment arrives, follows the output contract
  ([docs/04-orchestrator.md](04-orchestrator.md)), one section per capability,
  honest statuses.
- Diagnostics on any `partial`/`failed` section are present, verbatim, and
  **redacted** (no token-shaped strings).
- The Vercel function logs show the run completed within the time budget (no
  platform kill, no step retries).
- ~30 min later, the sandbox/snapshot inventory matches the steady state
  ([docs/06-sandbox-lifecycle.md](06-sandbox-lifecycle.md)).

## Billing watch — the gateway leak signal

After any dev-agent run, glance at the Vercel AI Gateway dashboard for this
project. Expected traffic there is ONLY the cheap loop models (requests worth
fractions of a cent). Any `anthropic/claude-*` row attributed to this project
means the nested Claude Code is billing through the Gateway at API prices
instead of the subscription — the auth block in `createClaudeCode` was
removed or broken (see [docs/05-dev-agent.md](05-dev-agent.md) §auth).
Subscription traffic never shows up in the Gateway at all, so this check is
cheap, unambiguous, and worth doing after every dependency bump of
`@ai-sdk/harness-claude-code`.

## Verification

- CI green on a trivial PR to the agent repo (every gate above).
- `curl -s -o /dev/null -w "%{http_code}" https://<domain>/eve/v1/health` → `200`.
- Manually dispatch the health-check workflow (`workflow_dispatch`) and confirm the
  ping step passes; if Resend is configured, temporarily point `EVE_HEALTH_URL` at
  a bogus path and confirm the alert email arrives, then restore it.
- The E2E probe PR passes the four checks above.
- **Owner checkpoint: one preview deploy to verify the bridge assets.** The
  hosted build output (`.vercel/output/functions/*.func`) cannot be produced
  locally without real Vercel credentials, so after any change to
  `scripts/copy-bridge-assets.mjs`, an eve bump or an
  `@ai-sdk/harness-claude-code` bump, deploy one preview and confirm the build
  log shows `[copy-bridge-assets] bridge assets → …/<fn>.func/…/bridge` (and no
  `refusing to ship`), then run one `warm_sandbox` against that preview (see
  above). A missing line means the dev-agent will fail with `ENOENT … bridge/…`.

Next: [docs/08-extensions.md](08-extensions.md) (optional add-ons) and
[docs/09-customization-checklist.md](09-customization-checklist.md) (the full
definition of done).
