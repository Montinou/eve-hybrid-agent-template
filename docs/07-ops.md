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
   estate, sandbox-config guards, prompt builders, secret-command execution).
3. **Instructions-hash drift gate** — `node scripts/hash-instructions.mjs --check`
   fails when [`agent/instructions.md`](../agent/instructions.md) and its committed
   hash ([`agent/lib/instructions-hash.ts`](../agent/lib/instructions-hash.ts)) are
   out of sync. This catches the classic failure of editing the prompt (or its
   generated snapshot) in one place only. If you edit the prompt, re-run
   `pnpm hash-instructions` and commit both files.

The deploy itself is `pnpm build && vercel deploy --prod` — **never bare
`eve build`**: the bundler inlines the claude-code bridge's code but not its data
files, so an unpatched bundle fails every dev-agent call with ENOENT at runtime
(gotcha #2). `scripts/copy-bridge-assets.mjs` copies the bridge into both output
trees and patches the server function's `maxDuration` to 800 in the same pass. The
`build` script in `package.json` already chains it; CI and any deploy pipeline must
go through that script.

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

Setup: in the agent repo's GitHub settings, add the repository **variable**
`EVE_HEALTH_URL` (e.g. `https://{{VERCEL_PROJECT}}.vercel.app/eve/v1/health`),
variables `ALERT_EMAIL_FROM` / `ALERT_EMAIL_TO`, and the **secret**
`RESEND_API_KEY`. Without the Resend pieces the ping still runs; only the alert
step is inert. (Email alerts are optional — see
[docs/08-extensions.md](08-extensions.md).)

## The E2E probe PR — expect it to find real bugs

The last step of setup is not a checklist item, it's a **discovery pass**: open a
real PR on an enabled estate repo, post the mention command
(`@{{BOT_NAME}} run`), and let every capability execute end-to-end through the
real channel, real dispatch, real sandbox, real repos.

Set expectations correctly: **the probe WILL find real bugs.** The reference
implementation's first E2E probe found three on day one — a sandbox runtime
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

## Verification

- CI green on a trivial PR to the agent repo (all three gates).
- `curl -s -o /dev/null -w "%{http_code}" https://<domain>/eve/v1/health` → `200`.
- Manually dispatch the health-check workflow (`workflow_dispatch`) and confirm the
  ping step passes; if Resend is configured, temporarily point `EVE_HEALTH_URL` at
  a bogus path and confirm the alert email arrives, then restore it.
- The E2E probe PR passes the four checks above.

Next: [docs/08-extensions.md](08-extensions.md) (optional add-ons) and
[docs/09-customization-checklist.md](09-customization-checklist.md) (the full
definition of done).
