import { defineEvalConfig } from "eve/evals";

// Required at the root of evals/ (node_modules/eve/docs/evals/cases.mdx). An
// empty config is enough here: the template's evals (delegation.eval.ts,
// routing.eval.ts) are deterministic. The cases that expect run_dev_task to be
// called stub it (the greeting case expects it NOT to be called, so it has no
// stub) and assert on the turn with succeeded / calledTool / notCalledTool
// gates plus a messageIncludes check, with no LLM judge, so no judge model or
// reporters are needed. Add `judge` (for t.judge.* LLM-graded assertions) or
// `reporters` (e.g. Braintrust) when you introduce fuzzy grading
// (docs/10-evals.md).
export default defineEvalConfig({});
