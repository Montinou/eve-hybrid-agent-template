# 09 — Master customization checklist

The complete, phase-ordered checklist for turning this template into your agent.
Each phase links to its doc; do not start a phase before the previous one's
"gate" is green. If you're driving this with a coding agent, point it at
[.claude/skills/hybrid-agent-setup/SKILL.md](../.claude/skills/hybrid-agent-setup/SKILL.md),
which encodes the same order with per-phase stop conditions.

## Placeholder table

Docs and examples use these tokens; replace them with your values wherever they
appear in *docs and example blocks*. Code files never contain them — code
customization points are `// CUSTOMIZE:` comments instead.

| Token | Meaning | Example |
|---|---|---|
| `{{AGENT_NAME}}` | The agent/repo name | `acme-review-agent` |
| `{{BOT_NAME}}` | The GitHub App's mention handle (without `@`) | `acme-review-bot` |
| `{{GITHUB_OWNER}}` | GitHub org/user owning the estate repos | `acme-inc` |
| `{{REPO_NAME}}` | A target estate repository | `acme-web` |
| `{{DOMAIN_TASK}}` | What your agent actually does | `dependency-risk review` |
| `{{VERCEL_PROJECT}}` | The Vercel project hosting the agent | `acme-review-agent` |

## Environment variable table

Full commented reference: [.env.example](../.env.example). Sensitive = set as a
Sensitive env var in Vercel ([docs/07-ops.md](07-ops.md)).

| Var | Layer | Default / notes |
|---|---|---|
| `ANTHROPIC_AUTH_TOKEN` | dev-agent | Sensitive. `claude setup-token`; expires ~1 yr, calendar the rotation |
| `AI_GATEWAY_API_KEY` | eve loop | Omit on Vercel (OIDC); needed for non-Vercel local runs |
| `ORCHESTRATOR_MODEL` | eve loop | `google/gemini-3.1-flash-lite` |
| `COMMAND_MODEL` | eve loop | `anthropic/claude-sonnet-4.5` |
| `DEV_AGENT_MODEL` | dev-agent | unset → Claude Code's default |
| `GITHUB_APP_ID` | channel | BYO GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | channel | Sensitive; `\n`-escaped PEM is normalized |
| `GITHUB_WEBHOOK_SECRET` | channel | Sensitive |
| `GITHUB_APP_INSTALLATION_ID` | git creds | optional; auto-discovered otherwise |
| `GITHUB_TOKEN` | git creds | optional PAT fallback |
| `DEV_AGENT_TIME_BUDGET_MS` | dev-agent | 700000; hard-clamped to 750000 in code |
| `SANDBOX_TIMEOUT_MS` | eve channel sandbox | 1800000 (30 min); a hard lifetime, floored at 800000; `SANDBOX_IDLE_TIMEOUT_MS` still accepted as an alias |
| `SANDBOX_SNAPSHOT_EXPIRATION_MS` | eve channel sandbox | 7 days |
| `TEMPLATE_SNAPSHOT_EXPIRATION_MS` | harness template | 7 days — **distinct lifecycle** from the previous knob |
| `RECIPE_VERSION` | harness template | bump on any sandbox-recipe change |
| `DEV_TASK_SECRETS_JSON` | dev-agent | optional JSON map; Sensitive; delivered env→tmp file |
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | ops | optional health alerts |

## Phase 0 — Prerequisites ([docs/01-prerequisites.md](01-prerequisites.md))

- [ ] Vercel account + project created; Pro plan if you need the 800s step budget
- [ ] Claude subscription; `claude setup-token` run; token + rotation date recorded
- [ ] GitHub App created (name = your bot handle), private key downloaded,
      webhook secret generated
- [ ] GitHub App **installed on every estate repo** (per-repo, silent when missing)
- [ ] pnpm + Node 24.x locally

## Phase 1 — Scaffold + deploy ([docs/02-scaffold-and-deploy.md](02-scaffold-and-deploy.md))

- [ ] Clone the template; `pnpm install`
- [ ] Rename identity fields (`package.json` name, sandbox `tags`, agent id) —
      follow the `// CUSTOMIZE:` markers
- [ ] `pnpm typecheck && pnpm test` green out of the box
- [ ] `pnpm dev` (eve dev) works locally
- [ ] `pnpm build && vercel deploy --prod` (never bare `eve build`)
- [ ] **Gate:** `GET /eve/v1/health` returns 200 on the production domain

## Phase 2 — Channel + dispatch ([docs/03-github-channel.md](03-github-channel.md))

- [ ] `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` set
      (Sensitive) in Vercel; App webhook URL → `POST /eve/v1/github`
- [ ] Dispatch rules adapted in `agent/lib/dispatch.ts` (pure functions; every
      attribute a tool will need projected into `auth.attributes`)
- [ ] Bot name updated — the `BOT_NAME` constant in `agent/lib/dispatch.ts`
      (`agent/channels/github.ts` only imports it), or set `GITHUB_APP_SLUG`
- [ ] `agent/channels/eve.ts` auth policy reviewed — the shipped
      `[vercelOidc(), localDev()]` never admits browser users or external
      clients; wire real auth (Clerk/Auth.js/API-key/OIDC) BEFORE exposing the
      chat/API surface publicly
- [ ] Dispatch unit tests updated and green
- [ ] **Gate:** a probe comment on an estate-repo PR produces a webhook delivery
      (green in the App's Advanced tab) and an agent turn

## Phase 3 — Orchestrator brain ([docs/04-orchestrator.md](04-orchestrator.md))

- [ ] `agent/instructions.md` rewritten for your domain — all six sections kept
      (identity, task contract, skills, security boundary, unattended, output
      contract)
- [ ] `agent/skills/*.md` rewritten: one workflow guide per procedure your
      agent owns (start from the shipped `dev-task`, `github-triage`,
      `sandbox-maintenance`, `release-check/`); descriptions written as
      routing hints; the prompt's Skills section lists exactly these
- [ ] Command→tool mapping in the prompt matches `dispatch.ts` attributes
- [ ] Loop models chosen (`ORCHESTRATOR_MODEL` / `COMMAND_MODEL`) or defaults kept
- [ ] Evals reviewed ([docs/10-evals.md](10-evals.md)): the mention
      command in `evals/routing.eval.ts` and `evals/delegation.eval.ts` matches
      your command grammar; `pnpm eval --list` shows the suite. Running the stubbed evals
      needs the `allowToolStubs` grant, which the shipped
      `agent/channels/eve.ts` does not give: decide, with your owner, whether and
      where to grant it before you rely on them
- [ ] `pnpm hash-instructions` re-run and hash committed
- [ ] **Gate:** probe comment gets a reply following the output contract; command
      turns run on the command model (check the Gateway dashboard)

## Phase 4 — Dev-agent + capabilities ([docs/05-dev-agent.md](05-dev-agent.md))

- [ ] `agent/lib/estate.ts` filled with your repos (owner/repo/branch/runtime/
      install/enabled) — sandbox runtime matches the TARGET repos' engines
- [ ] `ANTHROPIC_AUTH_TOKEN` set (Sensitive)
- [ ] `agent/lib/build-task-prompt.ts` adapted to your `{{DOMAIN_TASK}}`; tests green
- [ ] Per-run secrets (if any) wired via `DEV_TASK_SECRETS_JSON` — never in prompts
- [ ] Additional capabilities cloned from the `run_dev_task` pattern
      (prompt builder in `lib/` + thin `defineTool` + one prompt-contract line)
- [ ] **If any capability writes** (opens PRs on its own) — see
      [docs/05-dev-agent.md § Configuring a write-capable capability](05-dev-agent.md#configuring-a-write-capable-capability-autonomous-push):
  - [ ] Shape chosen deliberately (autonomous push vs host-side commit) and the
        choice recorded in your design doc, including what it trades away
  - [ ] `writeEnabled` per repo **and** `AGENT_WRITE_REPOS` — both required, both
        shipped off, so no single commit widens the blast radius
  - [ ] Git credential teardown made conditional on the mode: read-only
        capabilities must not hold a push-capable token
  - [ ] Write rules in the mode's instructions, ranked — with "push nothing when
        it is unsafe or ambiguous, and say why" at the same rank as the prohibitions
  - [ ] Per-repo forbidden zones in the per-repo skill markdown (tunable without
        a redeploy)
  - [ ] PRs open as **drafts**; no merge tool exists anywhere in the agent
- [ ] **Gate:** `warm_sandbox` returns `warmed: true`; a real `run_dev_task` probe
      returns a structured result on the PR

## Phase 5 — Lifecycle + cost hygiene ([docs/06-sandbox-lifecycle.md](06-sandbox-lifecycle.md))

- [ ] Sandbox knobs reviewed (defaults are sane); dev-agent forks still
      created with `persistent: false`
- [ ] Daily `template-maintenance` schedule deployed and observed running:
      it must report `warmed: true`
- [ ] `.github/workflows/sandbox-health.yml` configured; you know the repair
      for a lapsed eve template is a redeploy (docs/06-sandbox-lifecycle.md)
- [ ] `SANDBOX_SNAPSHOT_EXPIRATION_MS` NOT shortened to "save storage" —
      it governs eve's build-time template snapshot too, and a short TTL
      turns a quiet week into an outage
- [ ] `agent/schedules/template-maintenance.md` cron set to a suitable slot
      (Vercel evaluates schedule crons in UTC)
- [ ] `RECIPE_VERSION` set; bumped after any recipe edit you made in phase 4
- [ ] **Gate:** double-warm is a fast no-op; 30 min after a real run the
      sandbox/snapshot inventory matches the steady state
      (1 harness template sandbox + 1 template snapshot + zero fork snapshots;
      eve's own build-time template snapshot and per-session sandboxes and
      snapshots are eve-managed and healthy, docs/06-sandbox-lifecycle.md;
      nothing else lingering)

## Phase 6 — Ops ([docs/07-ops.md](07-ops.md))

- [ ] All env vars from the table above set in Vercel; secrets Sensitive
- [ ] CI green (typecheck + vitest + a build with no deprecation notice +
      instructions-hash gate)
- [ ] `EVE_HEALTH_URL` repo variable set; health-check workflow dispatched
- [ ] `sandbox-health.yml` enabled with `secrets.AGENT_API_KEY` (a bearer
      token your eve channel accepts: add an API-key verifier to
      `agent/channels/eve.ts` first, docs/07-ops.md) — health pings alone
      cannot see a dead sandbox
- [ ] `harness-auth-contract.test.ts` kept and its version pin current —
      it is the only guard against a dependency bump silently moving
      billing from your subscription to the AI Gateway
- [ ] Branch validated against its protected preview with
      `EVE_BYPASS_TOKEN` before merging any dependency bump
- [ ] Health-check workflow dispatched manually once and green; Resend alert
      configured (or consciously skipped)
- [ ] `ANTHROPIC_AUTH_TOKEN` rotation date in a human calendar
- [ ] **Gate:** the E2E probe PR — every capability exercised through the real
      channel; expect to fix a few real bugs here (the reference found three)

## Optional — Extensions ([docs/08-extensions.md](08-extensions.md))

- [ ] MCP connection(s) for external data
- [ ] Blob journal (`recall`/`remember`) + weekly digest schedule
- [ ] Evals grown from incidents, `live` evals added only where stubs cannot
      prove the behavior ([docs/10-evals.md](10-evals.md))
- [ ] Agent-sent email reports

## Definition of done

The agent is DONE when all of the following hold simultaneously:

1. **Green pipeline:** CI (typecheck, tests, hash gate) passes; deploy goes
   through `pnpm build`; health endpoint returns 200 from the external probe.
2. **E2E proof:** one probe PR exercised every capability through the real
   GitHub channel and produced a PR comment matching the output contract, with
   honest per-capability statuses and redacted diagnostics.
3. **Fail-soft proof:** at least one deliberately-broken run (disabled repo,
   missing secret) produced a structured `failed` result — no thrown error, no
   stalled session, no platform kill.
4. **Injection proof:** a PR embedding hostile instructions was ignored and the
   normal task ran.
5. **Cost steady state:** 24 h after the probe, the sandbox inventory is exactly
   1 harness template sandbox + 1 template snapshot + zero fork snapshots, plus
   eve's own build-time template snapshot and its per-session sandboxes and
   snapshots (eve-managed and healthy, `docs/06-sandbox-lifecycle.md`), nothing
   else; the daily maintenance schedule has run at least once.
6. **No placeholders left:** `git grep -n '{{'` over docs you customized returns
   only intentional examples; `git grep -n 'CUSTOMIZE:'` returns only markers you
   consciously decided to keep as-is.
7. **Humans in the loop where required:** token rotation date calendared; alert
   email (if configured) tested end-to-end.

## Verification

This doc *is* the verification artifact — run it top to bottom. Quick mechanical
pass:

```bash
pnpm typecheck && pnpm test
pnpm build
git grep -n 'CUSTOMIZE:' agent/ scripts/   # review every remaining marker
curl -s -o /dev/null -w "%{http_code}" "https://{{VERCEL_PROJECT}}.vercel.app/eve/v1/health"
```

Then the three live proofs: probe PR (phase 6 gate), broken-run proof, and the
next-day inventory check. When all seven definition-of-done items hold, the
template has become your agent.
