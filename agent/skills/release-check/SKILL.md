---
description: Use when asked whether a branch or PR is ready to release, to run the release checklist and report a go/no-go.
---

# Release readiness check

Example of a PACKAGED skill: a directory with `SKILL.md` plus sibling files
(`references/checklist.md` here). Flat `.md` files cover most workflows; use
a package when the procedure needs supporting material. Tools can read the
siblings at runtime via `ctx.getSkill("release-check").file(...)`.

## Workflow

1. Load the checklist in `references/checklist.md` — it is the single source
   of truth for what "ready" means. Do not improvise extra criteria.
2. Compose ONE dev task (see the dev-task skill) asking the nested dev-agent
   to evaluate the branch against each checklist item and return one line per
   item: `PASS`, `FAIL`, or `UNKNOWN`, with a one-sentence reason.
3. Report go/no-go: **go** only if every item is `PASS`. Any `FAIL` or
   `UNKNOWN` is a **no-go**; list the blocking items first, verbatim.

Customize `references/checklist.md` per project; keep the go/no-go rule
strict — the checklist is only as useful as it is honest.
