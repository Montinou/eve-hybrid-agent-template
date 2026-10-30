# eve-hybrid-agent-template

A GitHub template for building a **hybrid eve agent**: one durable
[eve](https://eve.dev) agent deployed on Vercel that splits every request into
a **cheap orchestration layer** (an AI-Gateway model driving the eve loop) and
an **expensive execution layer** (real Claude Code, authenticated with a Claude
**subscription** token, running inside a Vercel Sandbox via `@ai-sdk/harness`).

The hybrid consumption pattern itself (an AI Gateway orchestrator that calls a
tool, which runs subscription-authenticated Claude Code in a Vercel Sandbox) is
this template's own convention. It is built on eve and the AI SDK harness
packages (`@ai-sdk/harness`, `@ai-sdk/harness-claude-code`,
`@ai-sdk/sandbox-vercel`); it is not an eve feature, and eve itself documents no
subscription-auth path for its loop model.

The pattern is domain-agnostic. It comes from running this shape in production
(for example as a code-review QA agent or a ticket-triage agent); this template
ships the plumbing with the domain stripped out, ready to become a docs agent,
an ops agent, a test author, a migration bot — anything where a GitHub event should trigger a
frontier-model coding agent against real repo checkouts.

## Architecture

```
GitHub webhook ──► eve channel (deterministic dispatch, pure functions)
                     │
                     ▼
              eve loop (Vercel Workflow durable session)
              model: AI Gateway string, resolved dynamically PER TURN
              ├─ high-frequency turns → tiny model (ORCHESTRATOR_MODEL)
              └─ command turns        → mid model  (COMMAND_MODEL)
                     │  calls tools; each tool call = one Workflow step (~800s cap)
                     ▼
              capability tool (host-side: has network + secrets)
                     │  resolves context the sandbox can't reach,
                     │  builds the prompt, NEVER puts secrets in it
                     ▼
              dev-agent: HarnessAgent + createClaudeCode + createVercelNetworkSandboxSession
              — real Claude Code CLI, subscription auth (ANTHROPIC_AUTH_TOKEN),
                running INSIDE the sandbox against a pre-cloned repo estate
              — persistent template snapshot (warmed out-of-band) → fork per run
              — self-imposed time budget → structured partial results, never throws
```

Why this shape works:

- **Billing split.** The loop (many small turns) bills to Vercel AI Gateway;
  the brains (few big runs) bill to a Claude subscription's included usage and
  extra-usage credits. eve's loop model *cannot* use subscription tokens — the
  only place subscription auth works is Claude Code nested inside a tool,
  because there the whole CLI runs inside the sandbox. That constraint is
  load-bearing for the entire design (`docs/00-architecture.md`).
- **Latency/cost split.** Turn routing, comment posting, and result formatting
  don't need a frontier model. The nested dev-agent gets full repo checkouts,
  grep/bash, and hundreds of turns — where the frontier model actually pays off.
- **Fail-soft everywhere.** Every capability returns
  `{status: ok|partial|failed, summary, details?, diagnostics?}` and never
  throws. Platform timeouts are pre-empted by a self-imposed budget so partial
  work is always reported instead of lost.

## What's in the box

- **`agent/`** — the full eve agent: dynamic per-turn model routing
  (`agent.ts`), a generic orchestrator prompt with a security boundary and
  unattended-operation rules (`instructions.md`), a BYO GitHub App channel with
  deterministic, unit-tested dispatch (`channels/github.ts`), the standard eve
  HTTP channel for chat and API clients (`channels/eve.ts` — terminal UI,
  `useEveAgent`, curl, SDK; customize its auth before going public), and the
  eve channel sandbox (`sandbox.ts`).
- **`agent/skills/`** — one workflow guide per procedure, loaded on demand via
  `eve__skill` (progressive disclosure): `dev-task.md` (composing and running
  the nested dev-agent), `github-triage.md` (PR events and mention commands),
  `sandbox-maintenance.md` (warming + snapshot hygiene), and
  `release-check/` — a PACKAGED skill example (`SKILL.md` +
  `references/checklist.md`) showing the directory format. Add one skill per
  workflow your agent owns; keep `instructions.md` short and stable.
- **`agent/lib/dev-agent.ts`** — the hard-won core: HarnessAgent + Claude Code
  + Vercel Sandbox with template/fork lifecycle, time budgets, structured
  never-throw results, secret delivery via env maps, and snapshot hygiene.
- **`agent/tools/run_dev_task.ts`** — the one generic capability (run a nested
  Claude Code task against a repo of your estate). Clone it into your own
  domain capabilities.
- **`agent/tools/warm_sandbox.ts` + `agent/schedules/template-maintenance.md`**
  — out-of-band warming of the dev-agent's harness template and daily
  snapshot/cost sweeps.
- **`.github/workflows/sandbox-health.yml`** — watches eve's *own* sandbox
  template from outside. eve records that template as a snapshot during a
  build and never recreates it at runtime, so when its snapshot lapses the
  agent silently loses repo access — health endpoint still green — until
  someone redeploys. The probe makes the agent open a sandbox and alerts when
  it cannot. It, like `health-check.yml`, is inert until the repo variable
  `EVE_HEALTH_URL` is set (so this template and a fresh copy never run it);
  you turn both on in the ops phase ([docs/07-ops.md](docs/07-ops.md),
  "Template vs deployed agent").
- **`agent/lib/estate.ts`** — the repo registry: which repos the agent may
  touch, on which branch, with which package manager and runtime.
- **`scripts/copy-bridge-assets.mjs`** — the mandatory post-build step that
  makes the nested Claude Code bridge survive eve's bundler.
- **`scripts/orchestrate.mjs`** — drive the deployed agent from a terminal or
  from CI, including against a protection-gated preview deployment
  (`EVE_BYPASS_TOKEN`), so a dependency bump can be validated before it
  reaches production.
- **`evals/`** — a delegation eval and two routing evals, all tagged `fast`,
  that stub the heavy tool so they cost one orchestrator turn each. `pnpm eval`
  runs them; `pnpm eval --list` shows them without running anything. Stubbed
  evals need the `allowToolStubs` grant, which the shipped
  `agent/channels/eve.ts` does not give: that is an owner decision, described
  in [`docs/10-evals.md`](docs/10-evals.md).
- **`.github/workflows/`** — CI (typecheck, vitest, a build that fails on any
  deprecation notice, and the instructions-hash gate), plus two external crons
  with email alerting: a health check (is it serving?) and a sandbox health
  check (can it actually open a sandbox?). The second exists because the first
  cannot see the difference. Evals are not part of CI.
- **`docs/`** — a complete, ordered setup manual, from
  `docs/00-architecture.md` through `docs/10-evals.md`.
- **`.claude/skills/hybrid-agent-setup/SKILL.md`** — a step-by-step setup flow
  any coding agent (Claude Code, Codex, Cursor) can follow to configure the
  template for your domain.

The code is real and typechecks as-is with generic defaults. Every place you
are expected to change something is marked with a `// CUSTOMIZE:` comment
pointing at the relevant doc.

## Quickstart

1. **Use this template** (GitHub → "Use this template") and clone your copy.
2. `pnpm install`
3. Configure it — pick one:
   - **With a coding agent** (recommended): point your agent at the repo; it
     will find `AGENTS.md` / `CLAUDE.md` and follow
     `.claude/skills/hybrid-agent-setup/SKILL.md` — a strict 6-phase flow with
     verification gates.
   - **By hand**: read `docs/00-architecture.md` and
     `docs/01-prerequisites.md`, then work through
     `docs/02-scaffold-and-deploy.md` to `docs/07-ops.md` in order. Finish with the checklist in `docs/09-customization-checklist.md`.
4. Verify as you go: `pnpm typecheck && pnpm test`, deploy with
   `pnpm build` + `vercel deploy --prod`, and confirm
   `GET https://<deployment>/eve/v1/health` returns 200.

## Upgrading eve

eve is pre-1.0 and removes deprecated APIs between releases, so a bump can
break the build. After bumping `eve` (or `ai`, `@ai-sdk/*`, `@vercel/*`),
read the migration notes that ship with the installed version, starting at
`node_modules/eve/docs/guides/prepare-for-1-0.md`, then apply one rule:

```bash
pnpm typecheck && pnpm test && pnpm build
```

All three must pass, and `pnpm build 2>&1 | grep -i deprecat` must print
nothing: CI fails on any deprecation notice in the build output, so a
deprecated API is fixed in the bump that introduces the warning. A weekly
Dependabot PR proposes these bumps (see [`docs/07-ops.md`](docs/07-ops.md),
"Staying current"). pnpm 12 will not install a version published less than 24 h
ago (`minimumReleaseAge`): if `pnpm install --frozen-lockfile` fails with
`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`, never bypass the hold and never
commit an exclude list: wait until that release is 24 h old, then re-run CI.

## Docs index

| Doc | What it covers |
|---|---|
| [`docs/00-architecture.md`](docs/00-architecture.md) | The diagram, the two auth surfaces, the billing split, why this shape |
| [`docs/01-prerequisites.md`](docs/01-prerequisites.md) | Claude subscription token (`claude setup-token`), GitHub App creation, Vercel project |
| [`docs/02-scaffold-and-deploy.md`](docs/02-scaffold-and-deploy.md) | Phase 1 — install, `eve dev`, deploy, health 200 |
| [`docs/03-github-channel.md`](docs/03-github-channel.md) | Phase 2 — BYO App, deterministic dispatch, the attributes bridge |
| [`docs/04-orchestrator.md`](docs/04-orchestrator.md) | Phase 3 — instructions anatomy, security boundary, per-turn model routing |
| [`docs/05-dev-agent.md`](docs/05-dev-agent.md) | Phase 4 — harness anatomy, budgets, secrets, never-throw, the estate |
| [`docs/06-sandbox-lifecycle.md`](docs/06-sandbox-lifecycle.md) | Phase 5 — the two lifecycles, teardown, retention, sweeps |
| [`docs/07-ops.md`](docs/07-ops.md) | Phase 6 — Vercel env vars, CI, external health check, probe PR |
| [`docs/08-extensions.md`](docs/08-extensions.md) | Optional — MCP connections, cross-session memory, email |
| [`docs/09-customization-checklist.md`](docs/09-customization-checklist.md) | The full checklist + definition of done |
| [`docs/10-evals.md`](docs/10-evals.md) | Evals — what they cover, the stub pattern and its `allowToolStubs` prerequisite, `fast` and `live` tags, running them |

## Cost & billing — the honest version

This pattern is cheap to *run* but it is not free, and it bills to **three
places at once**. Know all three before deploying:

1. **Vercel AI Gateway** — every eve loop turn. With the default tiny/mid model
   split this is typically cents per day, but it scales with webhook traffic.
   On Vercel, OIDC covers auth automatically; otherwise set
   `AI_GATEWAY_API_KEY`.
2. **Claude subscription** — every dev-agent run burns subscription usage (and
   extra-usage credits once included usage is exhausted). This is the point of
   the pattern: frontier-model work at subscription prices instead of API
   prices. Caveats: the `claude setup-token` OAuth token **expires ~1 year
   after issuance and nothing alerts you** — calendar the rotation. And the
   token stays on the host (the sandbox gets a placeholder that the host swaps
   for the real bearer at egress), but code in a sandbox that processes
   untrusted content (PR diffs, comments) can still use it toward the
   Anthropic API; the blast radius is your subscription quota, not org data,
   but state that trade-off explicitly in your own security review.
3. **Vercel Sandbox compute + snapshot storage** — unavoidable. Forks are
   8-vCPU machines billed by the minute; template snapshots are multi-GB. The
   template creates forks non-persistent (no snapshot on teardown), destroys
   each one after its run, and ships three sweeps. The healthy steady state is
   **1 harness template sandbox + 1 template snapshot + zero fork snapshots**,
   plus eve's own per-session sandboxes and snapshots and its build-time
   template snapshot, which eve manages and expires. Anything beyond that is a
   leak; `docs/06-sandbox-lifecycle.md` tells you which
   mechanism missed it. The most expensive failure mode is a platform-timeout
   kill (up to 3 step retries × a fresh 8-vCPU sandbox), which is why the
   self-imposed ~700s budget is not negotiable.

## License

MIT — see [LICENSE](LICENSE).
