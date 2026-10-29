# 01 — Prerequisites: gather everything BEFORE starting

Collect all of the accounts, tokens, and tools in this doc before you run a single command. Half of them involve a wait (App creation, token issuance) or a human decision (which account pays for what) — doing them up front keeps the later phases mechanical.

Everything you collect here lands in an env var from the canon in [`.env.example`](../.env.example). Locally they go in `.env.local`; on Vercel they are set as project env vars (mark secrets **Sensitive** — see [docs/07-ops.md](07-ops.md)).

## 1. Local toolchain

- **Node 24.x** — the agent host runtime (`engines` in [`package.json`](../package.json)). Note: this is the *host* runtime; the sandbox where the dev-agent runs has its own, separate runtime pin matched to your target repos (see [docs/05-dev-agent.md](05-dev-agent.md)).
- **pnpm** — this template's package manager, pinned in the `packageManager` field of [`package.json`](../package.json) (`corepack enable` installs that exact version, or `npm i -g pnpm`). pnpm 12 will not install a release younger than 24 hours ([docs/07-ops.md](07-ops.md), "Staying current").
- **Vercel CLI** — `npm i -g vercel`.
- **Claude Code CLI** — needed once, on your machine, to mint the subscription token (below). The deployed agent installs its own copy inside the sandbox.

## 2. Claude subscription + `ANTHROPIC_AUTH_TOKEN`

The dev-agent authenticates as Claude Code with a **subscription OAuth token**, not an API key.

1. You need an active Claude subscription (Pro/Max) on the account that will pay for the heavy runs.
2. On a machine where `claude` is logged in to that account, run:

   ```bash
   claude setup-token
   ```

3. It prints a token starting with `sk-ant-oat01…`. That value becomes `ANTHROPIC_AUTH_TOKEN`.

Facts about this token you must plan around:

- **It expires ~1 year after issuance, and nothing alerts you.** Record the rotation date somewhere a human will actually see it — put a calendar reminder a couple of weeks before expiry, today, while you're thinking about it. When the agent's dev-runs suddenly all fail auth in a year, this is why.
- It is a full credential for your subscription's Claude Code usage. Treat it like a password: **Sensitive** env var on Vercel, never committed, never in prompts or logs.
- It does NOT work as an eve loop model credential — see [docs/00-architecture.md](00-architecture.md) § the load-bearing auth constraint. Do not set it hoping the loop picks it up; only `agent/lib/dev-agent.ts` uses it.
- Do not confuse it with `ANTHROPIC_API_KEY` (metered console billing). This pattern deliberately avoids the API key for the heavy layer.

## 3. Vercel project + AI Gateway

The agent deploys as a Vercel project; the eve loop bills its model calls through the **Vercel AI Gateway**.

1. Create (or pick) the Vercel team/account that will host the agent. A **Pro plan** is strongly recommended: the tool-step duration ceiling (~800s) and Sandbox limits on Hobby are tighter than the dev-agent's budget assumes.
2. You will create the actual project in phase 1 by running `vercel link` / `vercel deploy` from the repo ([docs/02-scaffold-and-deploy.md](02-scaffold-and-deploy.md)). Decide the project name now:

   ```text
   {{VERCEL_PROJECT}}   # e.g. my-team-dev-agent
   ```

3. **Gateway auth — two options:**
   - **On Vercel (deployed): nothing to do.** OIDC is automatic; leave `AI_GATEWAY_API_KEY` unset.
   - **Local dev:** either pull an OIDC token with `vercel env pull` after linking (it writes `VERCEL_OIDC_TOKEN`), or create an AI Gateway API key in the Vercel dashboard and set `AI_GATEWAY_API_KEY` in `.env.local`.
4. Make sure AI Gateway is enabled for the team and has a valid payment method — the loop's turns bill here.
5. **Vercel Sandbox** must be available on the team (it is, on current plans). The harness boots sandboxes in this same project's scope; no separate setup is needed, but be aware sandbox vCPU-minutes and snapshot storage bill to this team.

The model IDs themselves are env-overridable and default sensibly (`ORCHESTRATOR_MODEL`, `COMMAND_MODEL`, `DEV_AGENT_MODEL` — see [`agent/lib/model.ts`](../agent/lib/model.ts) and [docs/04-orchestrator.md](04-orchestrator.md)). Nothing to collect now.

## 4. GitHub App (bring your own)

The GitHub channel uses a GitHub App **you create and own** — not Vercel Connect, not a PAT-driven bot. One App serves all repos the agent will work on.

### Create the App

GitHub → your org (or user) → **Settings → Developer settings → GitHub Apps → New GitHub App**:

| Field | Value |
|---|---|
| **App name** | This becomes the bot's mention handle (the "bot name" used throughout the template docs). Pick it carefully — users will type it after `@` in PR comments. |
| **Homepage URL** | anything (your repo URL is fine) |
| **Webhook → Active** | ✅ checked |
| **Webhook URL** | `https://<deployment>/eve/v1/github` — you can enter a placeholder now and update it after the first deploy. eve serves the GitHub channel at exactly `/eve/v1/github`. |
| **Webhook secret** | Generate a strong random string (e.g. `openssl rand -hex 32`). This becomes `GITHUB_WEBHOOK_SECRET`. |

**Repository permissions** (minimum for this template):

| Permission | Access | Why |
|---|---|---|
| Contents | Read & write | clone/fetch in the sandbox; push branches if your capabilities write code |
| Pull requests | Read & write | read PR metadata, post result comments |
| Issues | Read & write | comment turns on issues, reactions |
| Metadata | Read | mandatory baseline |
| Checks | Read | only if you wire CI-event hooks later |

**Subscribe to events** — get this exact, misconfiguration is *silent*:

- `Pull request` — PR-event turns (opened/synchronize dispatch)
- `Issue comment` — **required** for `@mention` command turns
- `Pull request review comment` — **required** for mentions in review threads

(Optionally `Issues`, `Check suite`, `Check run`, `Workflow run` if you later add those hooks.)

**Where can this App be installed:** "Only on this account" is fine for a single org.

### After creation, collect three values

1. **App ID** → `GITHUB_APP_ID` (shown on the App's settings page).
2. **Private key** → `GITHUB_APP_PRIVATE_KEY`: click *Generate a private key*; a `.pem` downloads. The env var holds the full PEM text. Hosted platforms often `\n`-escape multiline values — the template normalizes escaped newlines back (see [`agent/lib/github-token.ts`](../agent/lib/github-token.ts)), so either form works.
3. **Webhook secret** → `GITHUB_WEBHOOK_SECRET` (the string you generated above).

### Install the App on your repos

App settings → **Install App** → choose the account → **select the repositories** the agent will serve.

> ⚠️ **Installation is per-repo and failure is silent.** A repo the App is not installed on simply never delivers webhooks — no error anywhere. Every repo you later add to the estate registry needs an App installation *first*. This is gotcha #12; it will bite you in phase 2 if you skip it. Details in [docs/03-github-channel.md](03-github-channel.md).

Optional related values:

- `GITHUB_APP_INSTALLATION_ID` — skips per-repo installation discovery when minting git tokens; grab it from the installation URL (`…/installations/<id>`) if you want, otherwise leave unset.
- `GITHUB_TOKEN` — a fine-grained PAT as a *fallback* git credential when App envs are absent. Not needed if the App is set up.

## 5. Optional extras (defer if unsure)

- **Resend** (`RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO`) — powers the external health-check alert in [`.github/workflows/health-check.yml`](../.github/workflows/health-check.yml). These live in GitHub Actions secrets, not in the Vercel deployment. See [docs/07-ops.md](07-ops.md).
- **Per-run secrets** (`DEV_TASK_SECRETS_JSON`) — a JSON map of secrets your dev-tasks need inside the sandbox (staging credentials, etc.), delivered via env→tmp-file, never via prompts. See [docs/05-dev-agent.md](05-dev-agent.md).

## Collected-values checklist

```bash
# Required before phase 1 (docs/02)
ANTHROPIC_AUTH_TOKEN=sk-ant-oat01...      # claude setup-token — CALENDAR THE ~1yr EXPIRY
# AI_GATEWAY_API_KEY=...                  # local dev only; omit on Vercel (OIDC)

# Required before phase 2 (docs/03)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n..."
GITHUB_WEBHOOK_SECRET=...

# Decided (not env vars): {{VERCEL_PROJECT}}, {{BOT_NAME}}, {{GITHUB_OWNER}}/{{REPO_NAME}}
```

## Verification

- [ ] `node --version` prints 24.x; `pnpm --version` works; `vercel whoami` prints the right account.
- [ ] `ANTHROPIC_AUTH_TOKEN` starts with `sk-ant-oat01` and a calendar reminder exists for its ~1-year expiry.
- [ ] The Vercel team has AI Gateway enabled with billing configured.
- [ ] The GitHub App exists; you have all three of App ID / PEM / webhook secret; events include `Pull request`, `Issue comment`, and `Pull request review comment`.
- [ ] The App is **installed on every repo** the agent will serve (check *Install App* → Repository access).
- [ ] The webhook URL points at (or will be updated to) `https://<deployment>/eve/v1/github`.

Next: [docs/02-scaffold-and-deploy.md](02-scaffold-and-deploy.md) — get the skeleton deployed and healthy.
