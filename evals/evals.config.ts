import { defineEvalConfig } from "eve/evals";

// Required at the root of evals/ (node_modules/eve/docs/evals/cases.mdx). An
// empty config is enough here: the template's routing eval uses run-level
// gates only (t.succeeded / t.calledTool), so no judge model or reporters are
// needed. Add `judge` (for t.judge.* LLM-graded assertions) or `reporters`
// (e.g. Braintrust) when you introduce fuzzy grading — docs/08-extensions.md.
export default defineEvalConfig({});
