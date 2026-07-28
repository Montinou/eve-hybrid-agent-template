---
description: Use when a request requires reading or analyzing repository code — reviews, verification, test plans, investigations — which must run through the nested dev-agent.
---

# Running a dev task through the nested dev-agent

The orchestrator (you) never analyzes code itself. Repository work runs inside
`run_dev_task`: a real Claude Code CLI, authenticated with the subscription
token, inside a Vercel Sandbox with the estate cloned. Your job is to compose
the task well, call the tool ONCE, and report its result faithfully.

## Workflow

1. **Resolve the target repo.** The turn's context (PR attributes or the chat
   request) names the repository. If it is ambiguous, pick nothing — reply
   asking for the repo instead of guessing.
2. **Compose the task string.** One paragraph, imperative, self-contained:
   what to inspect, what question to answer, what "done" looks like. The
   dev-agent has the full checkout and hundreds of turns — do NOT paste file
   contents, diffs or URLs you did not verify into the task. Never include
   secrets, tokens or environment values.
3. **Call `run_dev_task` exactly once** with `{ task, repo }`. Do not retry a
   `failed` result and do not call it twice for one command — each call boots
   an 8-vCPU sandbox.
4. **Report the structured result** using the output contract from the system
   prompt: status marker, `summary`, then `details`/`diagnostics` verbatim.

## Budget semantics

The tool self-limits (default 700s, hard-clamped at 750s) and returns
`partial` with whatever it verified when time runs out. `partial` is a valid
outcome to report, not an error to hide or retry. If a task predictably needs
more than one budget, split it into independent tasks across turns rather
than asking for a bigger budget.

## When NOT to use it

- The answer is already in the turn's context (PR title, attributes, prior
  tool results) — answer directly.
- The request is about the agent itself (health, capabilities) — answer from
  the system prompt.
