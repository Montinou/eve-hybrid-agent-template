# 10 — Evals

Evals check behavior that only the live orchestrator loop can show: does a
command turn reach the right tool, does a heavy task get delegated exactly once,
does a greeting stay cheap. This page is the working guide; the framework API is
in `node_modules/eve/docs/evals/` (`overview.mdx`, `cases.mdx`, `assertions.mdx`,
`tool-stubs.mdx`, `running.mdx`, `targets.mdx`).

## What evals cover, and what unit tests cover

| Question | Where it is checked |
|---|---|
| Which model id a turn uses (command turn vs. ordinary turn) | Unit test, [`agent/lib/model.test.ts`](../agent/lib/model.test.ts) and [`agent/lib/dispatch.test.ts`](../agent/lib/dispatch.test.ts) |
| Command parsing, estate gates, session-auth projection | Unit test, [`agent/lib/dispatch.test.ts`](../agent/lib/dispatch.test.ts) |
| Which tool the model picks for a given message | Eval |
| Whether the tool result reaches the user | Eval |

The model choice per turn is unit-tested and not eval-tested on purpose. An eval
drives the agent through the client-session surface, and `SendTurnPayload` has no
`auth` field, so an eval cannot set the `command` session-auth attribute that
makes [`agent/agent.ts`](../agent/agent.ts) pick the command model. What an eval
can exercise is the message text, which is what the model routes on. The header
of [`evals/routing.eval.ts`](../evals/routing.eval.ts) spells this out. Keep
deterministic logic in `agent/lib/` with vitest; write an eval only for what the
live loop alone can prove.

## Credentials: AI Gateway only

Evals run against a live model, so the runner needs model credentials. Give it
the **AI Gateway** credential and nothing else:

- OIDC via `vercel env pull` (writes `VERCEL_OIDC_TOKEN`), or
- `AI_GATEWAY_API_KEY` in `.env.local` for local runs
  ([docs/01-prerequisites.md](01-prerequisites.md)).

Never put the subscription token (`ANTHROPIC_AUTH_TOKEN`) in an eval environment.
The `fast` evals do not need it: the heavy tool is stubbed, so no dev-agent boots
and the Claude subscription is never touched. A `live` eval needs it only on the
deployment it targets (see below), never on the machine that runs the evals.

## The stub pattern

`run_dev_task` is the expensive tool: it boots a sandbox and a Claude Code
session. An eval that only wants to know whether the orchestrator *delegated*
should not pay for that. eve tool stubs replace the tool's execution with a JSON
response while keeping its input schema, approvals and output processing
(`node_modules/eve/docs/evals/tool-stubs.mdx`).

[`evals/delegation.eval.ts`](../evals/delegation.eval.ts) is the reference:

```ts
const session = await t.session({
  stubs: [
    {
      id: "dev",
      tool: "run_dev_task",
      outcome: {
        response: { status: "ok", summary: "stubbed-result", capability: "task" },
      },
    },
  ],
});
const turn = await session.send(`@${BOT_NAME} run`);
turn.succeeded().gate();
turn.calledTool("run_dev_task", { count: 1 }).gate();
turn.messageIncludes("stubbed-result");
```

- The stub response uses `run_dev_task`'s real output shape (the dev-agent result
  plus the `capability` tag, see [`agent/tools/run_dev_task.ts`](../agent/tools/run_dev_task.ts)).
  When that shape changes, update the stubs in `evals/delegation.eval.ts` and
  `evals/routing.eval.ts`.
- `calledTool(..., { count: 1 })` is the "exactly once" gate; `messageIncludes`
  proves the tool result reached the user.
- An unused stub only warns. Use `calledTool` when a call must happen.

### Prerequisite: tool replacement is denied by default

Creating a stubbed session requires `allowToolStubs: true` in the verified route
authentication result of the target's eve channel
(`node_modules/eve/docs/guides/auth-and-route-protection.md`, "Tool replacement
permission"). Request JSON cannot grant it. The template's
[`agent/channels/eve.ts`](../agent/channels/eve.ts) uses
`auth: [vercelOidc(), localDev()]` and does **not** grant it, so as shipped the
stubbed evals are rejected at session creation.

This is a decision for the agent's owner, not something to flip while setting
up evals. The options the eve docs describe:

- **Local development only:** a custom authenticator that wraps `localDev()` and
  adds `allowToolStubs: true` to the caller it returns.
- **A dedicated eval-runner subject:** with `eveVercelOidc`, put
  `allowToolStubs: true` on the `subjects` entry of a separate eval-runner
  project, so ordinary callers never receive it.

Anyone the channel admits to an existing session can use that session's stubs,
so keep the grant off any production subject unless Security has reviewed it.
Until the owner has made this choice, treat the stub-based evals as written but
not yet runnable.

## Listing the evals

`pnpm eval` runs `eve eval --exclude-tag live` (the `eval` script in
[`package.json`](../package.json)). To see what it would run without running
anything, add `--list` (the same as `eve eval --list`, with the `live` exclusion
applied):

```bash
pnpm eval --list
```

The suite as shipped prints:

```text
delegation [fast] — GATE: a heavy task is delegated to run_dev_task once and its result is relayed
routing/0000 [fast] — GATE: a mention command routes to the run_dev_task capability tool.
routing/0001 [fast] — GATE: a plain greeting must NOT trigger the expensive dev-agent capability.
```

`delegation` is [`evals/delegation.eval.ts`](../evals/delegation.eval.ts).
`routing/0000` and `routing/0001` are the two entries of the array exported by
[`evals/routing.eval.ts`](../evals/routing.eval.ts). Run one by id, or a group
by prefix, with the same script: `pnpm eval delegation`, `pnpm eval routing`.

[`evals/evals.config.ts`](../evals/evals.config.ts) is empty on purpose: every
assertion is a deterministic gate (`succeeded`, `calledTool`, `notCalledTool`,
`messageIncludes`), so no judge model and no reporter is needed. Add a `judge`
or `reporters` there only when you introduce LLM-graded assertions.

## Tags: `fast` and `live`

Every eval carries a tag, and the tag says what it may cost:

| Tag | Meaning | In `pnpm eval` |
|---|---|---|
| `fast` | One orchestrator turn. Heavy tools are stubbed; no sandbox is started. | Yes |
| `live` | Exercises the real `run_dev_task`. The only kind that may start a sandbox and a Claude Code session. | No (`--exclude-tag live`) |

### Adding a `live` eval

1. Create `evals/<name>.eval.ts` with `tags: ["live"]` and **no** `stubs` for
   `run_dev_task`, so the real tool runs.
2. Keep it to one narrow case. It starts a sandbox and spends subscription
   quota, so a live eval should check what the stubs cannot: the real tool's
   result reaching the user, or sandbox start and teardown.
3. Run it against a deployment, not your machine, so the subscription token stays
   where it already lives:

   ```bash
   pnpm exec eve eval --tag live --url https://<your-app>
   ```

   For a remote `--url`, eve authenticates with the Vercel credentials described
   in `node_modules/eve/docs/evals/targets.mdx` (`VERCEL_OIDC_TOKEN`, or
   `EVE_EVAL_AUTH_TOKEN` for a non-OIDC target). The target's channel must admit
   that caller as a service principal.
4. Run it by hand, on a prompt or tool change. `--tag live` fails with exit code
   `2` when no eval carries the tag, so a repo without live evals reports a
   configuration error there. That is expected.

## Running against a deployment

```bash
pnpm eval --url https://<your-app>
```

`--url` points the same eval files at an existing server instead of the local dev
server the runner would otherwise boot. Use it to check a preview or a
production build of the orchestrator. If the preview sits behind Deployment
Protection, see [docs/07-ops.md](07-ops.md) for the bypass secret. Stubbed evals
against a deployment also need the `allowToolStubs` grant on the runner's subject
(above).

## CI

Evals are **not** in CI by default. [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
says so in its header: they run against a live model and cost money, so run them
on demand, when `agent/instructions.md`, the tool descriptions or the model ids
change. The per-PR gate stays typecheck, unit tests, build and drift checks.

If you decide to add them later, use the framework's CI shape from
`node_modules/eve/docs/evals/running.mdx` (`--strict`, `--junit .eve/junit.xml`,
upload `.eve/evals/` as a failure artifact), keep `--exclude-tag live`, and give
the job the AI Gateway credential only.

## Growing the suite

Add a case from every incident: when the deployed agent mis-routes or breaks its
contract, add the failing transcript as an eval before changing the prompt.
Evals are the regression suite for `agent/instructions.md` the way vitest is for
`agent/lib/`. See also [docs/08-extensions.md](08-extensions.md).
