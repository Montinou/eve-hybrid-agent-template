# Instructions for coding agents

This repository is a **template** for a hybrid eve agent (cheap AI-Gateway
orchestrator loop + subscription Claude Code running inside a Vercel Sandbox).
These instructions apply to ANY coding agent working here — Claude Code, Codex,
Cursor, or anything else that can read markdown and run shell commands.

## 1. If you are configuring this template into a real agent

Read `.claude/skills/hybrid-agent-setup/SKILL.md` FIRST, before touching any
file. It is plain markdown — no Claude-specific tooling required. It defines a
strict 6-phase order (scaffold+deploy → channel+dispatch → orchestrator brain →
dev-agent+capabilities → lifecycle+cost hygiene → ops), and each phase has a
verification gate. **Do not skip phases and do not reorder them** — each phase
is independently verifiable and later phases assume earlier gates passed.

## 2. Before writing ANY eve code

Read the bundled eve docs — they are versioned with the installed framework and
beat memory/training data every time:

1. Start at `node_modules/eve/docs/README.md`.
2. Then read the specific reference page for what you are about to write
   (`reference/`, `channels/`, `tools/`, `schedules.mdx`, `sandbox.mdx`).

Never invent eve APIs. Every `defineAgent` / `defineTool` / `defineSandbox` /
`defineDynamic` / `githubChannel` usage must match the bundled docs.

## 3. Repository conventions

- **Package manager: pnpm.** Do not use npm or yarn; wrong managers regenerate
  lockfiles and break CI.
- **Never run bare `eve build`.** Always `pnpm build` (= `eve build` + the
  `scripts/copy-bridge-assets.mjs` post-processing step). A bare `eve build`
  ships a bundle whose nested Claude Code bridge fails at runtime with ENOENT.
- **All real logic lives in `agent/lib/` as pure functions** with vitest unit
  tests; `agent/tools/*.ts` and `agent/channels/*.ts` are thin wrappers. Keep
  it that way — it is what makes the agent testable without deploys.
- Verify your work: `pnpm typecheck && pnpm test` after every change.
- Customization points in code are marked with `// CUSTOMIZE:` comments that
  point to the relevant `docs/NN-*.md` page. Edit at those markers; do not
  rewrite the load-bearing plumbing around them.

## 4. Documentation map

`docs/` is ordered and phase-aligned — read the matching doc before each phase:

| Doc | Covers |
|---|---|
| `docs/00-architecture.md` | The shape, the billing split, why it works |
| `docs/01-prerequisites.md` | Accounts, tokens, GitHub App, Vercel project |
| `docs/02-scaffold-and-deploy.md` | Phase 1 |
| `docs/03-github-channel.md` | Phase 2 |
| `docs/04-orchestrator.md` | Phase 3 |
| `docs/05-dev-agent.md` | Phase 4 |
| `docs/06-sandbox-lifecycle.md` | Phase 5 |
| `docs/07-ops.md` | Phase 6 |
| `docs/08-extensions.md` | Optional extensions |
| `docs/09-customization-checklist.md` | Definition of done |

## 5. Hard constraints

There are 12 hard constraints (each one cost a real production debugging
session in the reference implementation). The condensed list lives in
`.claude/skills/hybrid-agent-setup/SKILL.md` under "Hard constraints"; the full
rationale for each is spread across `docs/00`–`docs/07`. Violating any of them
produces silent breakage or cost leaks — read the list before changing
`agent/lib/dev-agent.ts`, `agent/sandbox.ts`, `agent/agent.ts`,
`agent/channels/github.ts`, or `package.json` scripts.
