import { describe, expect, it } from "vitest";
import { buildTaskPrompt } from "./build-task-prompt.ts";
import { ESTATE, ESTATE_ROOT } from "./estate.ts";

const target = ESTATE[0]!;

const context = {
  repository: target.repo,
  branch: "feature/some-change",
  pr_number: 42,
  author: "octocat",
};

describe("buildTaskPrompt", () => {
  it("embeds the task text verbatim", () => {
    const prompt = buildTaskPrompt({
      task: "Summarize what the checkout flow does.",
      context,
      target,
    });
    expect(prompt).toContain("Summarize what the checkout flow does.");
  });

  it("points at the resolved estate checkout path", () => {
    const prompt = buildTaskPrompt({ task: "x", context, target });
    expect(prompt).toContain(`${ESTATE_ROOT}/${target.dir}`);
  });

  it("still produces a usable prompt for an unresolved repo (runDevAgent is what fails soft)", () => {
    const prompt = buildTaskPrompt({
      task: "x",
      context: { ...context, repository: "SomeOrg/nope" },
      target: undefined,
    });
    expect(prompt).toContain(`${ESTATE_ROOT}/<unresolved repo: SomeOrg/nope>`);
  });

  it("includes branch, PR number, and author from the context", () => {
    const prompt = buildTaskPrompt({ task: "x", context, target });
    expect(prompt).toContain("feature/some-change");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("octocat");
  });

  it("omits PR number and author lines when absent", () => {
    const prompt = buildTaskPrompt({
      task: "x",
      context: { repository: target.repo, branch: "main" },
      target,
    });
    expect(prompt).not.toContain("PR number");
    expect(prompt).not.toContain("Author:");
  });

  it("falls back to 'unknown' for a blank branch", () => {
    const prompt = buildTaskPrompt({
      task: "x",
      context: { repository: target.repo, branch: "" },
      target,
    });
    expect(prompt).toContain("- Branch: unknown");
  });

  it("adds a credentials section referencing the secrets PATH only when secretsPath is given", () => {
    const withSecrets = buildTaskPrompt({
      task: "x",
      context,
      target,
      secretsPath: "/tmp/dev-task-secrets.json",
    });
    expect(withSecrets).toContain("## Credentials");
    expect(withSecrets).toContain("/tmp/dev-task-secrets.json");

    const withoutSecrets = buildTaskPrompt({ task: "x", context, target });
    expect(withoutSecrets).not.toContain("## Credentials");
  });

  it("appends host-resolved extra context as its own section", () => {
    const prompt = buildTaskPrompt({
      task: "x",
      context,
      target,
      extraContext: "## Linked ticket\n\nTICKET-1: fix the widget",
    });
    expect(prompt).toContain("## Additional context (host-resolved)");
    expect(prompt).toContain("TICKET-1: fix the widget");

    const bare = buildTaskPrompt({ task: "x", context, target });
    expect(bare).not.toContain("## Additional context (host-resolved)");
  });
});
