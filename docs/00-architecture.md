# 00 — Architecture: why the hybrid shape

Read this first. Every later doc assumes you understand the split described here.

## The pattern in one paragraph

One durable [eve](https://eve.dev) agent deployed on Vercel splits every request into a **cheap orchestration layer** and an **expensive execution layer**, with different auth and different billing for each. A small AI-Gateway model runs the loop (routing turns, calling tools, formatting results); the heavy work runs as **real Claude Code** — subscription auth, full CLI — inside a Vercel Sandbox, launched from a tool via `@ai-sdk/harness`.

## The diagram

```
GitHub webhook ──► GitHub channel (deterministic dispatch, pure functions)
                     │           agent/channels/github.ts + agent/lib/dispatch.ts
chat / API ───────► standard eve channel (HTTP: terminal UI, useEveAgent, curl, SDK)
                     │           agent/channels/eve.ts (customize auth before public)
                     ▼
              eve loop (Vercel Workflow durable session)
              skills: agent/skills/*  (workflow guides, loaded via load_skill)
              model: AI Gateway string, dynamic PER TURN   (agent/agent.ts)
              ├─ high-frequency turns → tiny model   (ORCHESTRATOR_MODEL)
              └─ command turns        → mid model    (COMMAND_MODEL)
                     │  calls tools; each tool call = one Workflow step (~800s cap)
                     ▼
              capability tool (host-side: has network + secrets)
                     │  agent/tools/run_dev_task.ts
                     │  resolves context the sandbox can't see, builds the
                     │  prompt, NEVER puts secrets in it
                     ▼
              dev-agent: HarnessAgent + createClaudeCode + createVercelSandbox
              (agent/lib/dev-agent.ts)
              — real Claude Code CLI, subscription auth (ANTHROPIC_AUTH_TOKEN),
                running INSIDE the sandbox against a pre-cloned repo estate
              — template snapshot (warmed out-of-band) → throwaway fork per run
              — self-imposed time budget → structured partial results,
                never throws
```

## The billing split

The loop generates many small turns; the dev-agent generates a few big runs. They bill to different meters:

| Layer | Runs where | Model config | Auth | Bills to |
|---|---|---|---|---|
| eve loop turns (routing, orchestration, comment posting) | Vercel function (host) | AI Gateway string (e.g. `anthropic/claude-sonnet-4.5`) or an AI SDK `LanguageModel` | Vercel OIDC (automatic on Vercel) or `AI_GATEWAY_API_KEY` | Vercel AI Gateway (or the provider console, for a provider `LanguageModel`) |
| Nested dev-agent (Claude Code CLI) | INSIDE the Vercel Sandbox | `createClaudeCode({ auth: { anthropic: { authToken } }, model? })` — the explicit auth block is REQUIRED (see below) | `ANTHROPIC_AUTH_TOKEN` (subscription OAuth from `claude setup-token`) | Claude subscription + its extra-usage credits |
| Sandbox compute | Vercel | — | — | Vercel (vCPU-minutes + snapshot storage); unavoidable |

## The latency/cost split

Turn routing, comment posting, and result formatting do not need a frontier model — a tiny Gateway model handles them in a second or two, for fractions of a cent. The nested dev-agent is where the frontier model actually pays off: it gets full repo checkouts, `grep`/`bash`, and hundreds of internal turns to do real work on real code. Routing intelligence lives in **deterministic dispatch code**, not in either model: the channel decides *whether* a turn happens and projects *what* the tools will see (see [docs/03-github-channel.md](03-github-channel.md)); the orchestrator model just maps commands to tools.

## The load-bearing auth constraint

**eve's loop cannot authenticate with a Claude subscription token.** This is the single fact the whole design hangs on — do not re-litigate it:

- `defineAgent`'s `model` accepts ONLY (a) a Gateway model string, or (b) an AI SDK `LanguageModel` backed by a provider API key. There is no way to hand eve a subscription OAuth token (`sk-ant-oat01…`). Verified against eve's bundled docs and source, 0.24 through 0.44.
- The structural reason: the loop's model call happens on the **host** (the Vercel function). Subscription auth is a Claude-Code-surface entitlement — it only works where the entire Claude Code CLI runs. In this pattern that is *inside the sandbox*, via `@ai-sdk/harness-claude-code`.
- **And the harness must be told explicitly.** Its auth resolution prefers gateway credentials found in the env (automatic OIDC on Vercel) over `ANTHROPIC_AUTH_TOKEN` whenever auth is left at its `"auto"` default — the nested agent then silently bills Opus through the AI Gateway at API prices (a real US$7.79/week leak, caught 2026-07-27). `createClaudeCode` MUST receive **`auth: "direct"`** (the object form, `{ anthropic: { authToken } }`, resolves identically but is deprecated — and is silently ignored by versions predating it). Precedence re-verified unchanged at 1.0.42, 1.0.65 and 1.0.88. **Detection:** `anthropic/claude-*` rows attributed to the project in the AI Gateway dashboard — subscription traffic never appears there. See [docs/05-dev-agent.md](05-dev-agent.md).
- Subscription extra-usage credits only burn on Claude-Code surfaces with subscription auth. They do NOT apply to Gateway or `ANTHROPIC_API_KEY` traffic. That is exactly why the heavy layer uses the harness: the expensive runs draw on a flat-rate subscription instead of metered API billing.

So the **only** place the subscription token appears is `agent/lib/dev-agent.ts`, where it is guarded for presence and passed EXPLICITLY as the harness's `auth.anthropic.authToken`. It never configures the loop model, and it never appears in prompts or logs.

**Accepted risk (state it in your own design doc):** the token is forwarded to the sandbox bridge, so it exists inside a sandbox that processes untrusted content (PR diffs, comments). Mitigations: the token is revocable, blast radius is subscription quota — not org data — and the orchestrator's security-boundary instructions (see [docs/04-orchestrator.md](04-orchestrator.md)) treat all webhook content as untrusted input.

## Fail-soft everywhere

Every capability returns a structured result — `{ status: "ok" | "partial" | "failed", summary, details?, diagnostics? }` — and **never throws**. A tool call is one Vercel Workflow step with a hard ~800s cap; a platform kill loses all work AND triggers up to 3 step retries, each booting a fresh 8-vCPU sandbox. The dev-agent therefore self-terminates at ~700s (`DEV_AGENT_TIME_BUDGET_MS`) and reports partial work honestly. Details in [docs/05-dev-agent.md](05-dev-agent.md).

## Two sandbox lifecycles (don't confuse them)

| | eve's own channel sandbox | harness template/forks |
|---|---|---|
| Defined in | `agent/sandbox.ts` | `agent/lib/dev-agent.ts` |
| Purpose | tool-exec env for the eve loop (channel checkouts, bash) | the dev-agent's world (estate clones, Claude Code) |
| Persistence | one durable sandbox per session; idle-expires → snapshot → resumes | one persistent TEMPLATE + a throwaway FORK per run |
| Knobs | `SANDBOX_IDLE_TIMEOUT_MS`, `SANDBOX_SNAPSHOT_EXPIRATION_MS` | `TEMPLATE_SNAPSHOT_EXPIRATION_MS` + provider options |

Confusing the two is the #1 source of mystery Vercel costs. Full treatment in [docs/06-sandbox-lifecycle.md](06-sandbox-lifecycle.md).

## When to use this pattern (and when not)

Use the hybrid pattern when **all** of these hold:

1. The agent needs to do real engineering work on repositories — read code, run commands, edit files, reason across many internal turns. That is what the nested Claude Code buys you.
2. The trigger volume is asymmetric: many cheap events (webhooks, comments, schedules) but only some of them warrant an expensive run. The dispatch + routing layers keep the cheap path cheap.
3. You have a Claude subscription whose credits you want to spend instead of metered API billing for the heavy runs.
4. Runs must survive platform limits: durable sessions, budget discipline, partial results.

Use a **plain eve agent** (one Gateway model, tools running on the host, no harness) when:

- Tools are API calls or light computation — nothing needs a repo checkout or a nested agent. eve's default harness already gives file/shell/web tools in its own sandbox.
- One model tier serves every turn: skip `defineDynamic` and set a single `model` string.
- You are fine billing everything through the Gateway. The hybrid's extra moving parts (bridge assets, template warming, snapshot hygiene, budget discipline) are the price of the subscription split — don't pay it if you don't need it.

A useful middle ground: start plain, and adopt only the pieces you need. The template is factored so the dev-agent (`agent/lib/dev-agent.ts` + `agent/tools/run_dev_task.ts`) is removable without touching the channel or the loop.

## Real-world example

This template is the domain-stripped scaffold of a production QA agent: a GitHub App listens to PR events on a frontend monorepo, a flash-lite model handles high-frequency shadow turns, `@bot` commands route to a mid-tier orchestrator model, and nested Claude Code runs code review / test planning / preview validation inside the sandbox against a multi-repo estate. Everything here — the budget clamp, the fork-teardown patch, the bridge-asset copy — exists because it failed in that production system first.

## Where each concept lives in the template

| Concept | File |
|---|---|
| Per-turn dynamic model routing | `agent/agent.ts`, `agent/lib/model.ts` |
| Orchestrator prompt + security boundary | `agent/instructions.md` |
| Deterministic dispatch | `agent/channels/github.ts`, `agent/lib/dispatch.ts` |
| The nested dev-agent | `agent/lib/dev-agent.ts`, `agent/tools/run_dev_task.ts` |
| Repo estate registry | `agent/lib/estate.ts` |
| eve channel sandbox | `agent/sandbox.ts`, `agent/lib/sandbox-config.ts` |
| Template warming + sweeps | `agent/tools/warm_sandbox.ts`, `agent/lib/template-sweep.ts`, `agent/schedules/template-maintenance.md` |
| Build post-processing | `scripts/copy-bridge-assets.mjs` |
| External health monitoring | `.github/workflows/health-check.yml` |

## Verification

Before moving on, you should be able to answer these without re-reading:

- [ ] Which layer bills to the AI Gateway and which to the Claude subscription?
- [ ] Why can't `ANTHROPIC_AUTH_TOKEN` be used as the eve loop's model credential? (Where is the only place it works?)
- [ ] What is the difference between the eve channel sandbox and the harness template/fork sandboxes?
- [ ] Why does the dev-agent self-terminate at ~700s instead of letting the platform kill it at ~800s?
- [ ] Would a plain eve agent serve your use case? If yes, stop here and run `npx eve@latest init` instead.

Next: [docs/01-prerequisites.md](01-prerequisites.md) — everything to gather before you touch the code.
