import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A template repository must behave like a template, not like a deployed
// project. The scheduled probes in .github/workflows/ are scaffolding for the
// repos DERIVED from this template: on the template itself (and on a fresh
// copy) no agent is deployed, so a probe that runs would fail, turn the run red
// and email the owner. These tests pin that every scheduled workflow stays
// inert until `vars.EVE_HEALTH_URL` is set, and that the PR/push CI needs no
// configuration to be green. Plain text checks: no YAML dependency.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = join(ROOT, ".github/workflows");

type Workflow = {
  file: string;
  source: string;
  /** The text of the top-level `on:` block (trigger declarations). */
  triggers: string;
  /** The leading `#` comment block, comment markers stripped. */
  header: string;
  /** Job id -> the job's block of text (from its key to the next job). */
  jobs: Map<string, string>;
  /** The workflow without comment lines. */
  code: string;
};

function parse(file: string): Workflow {
  const source = readFileSync(join(WORKFLOW_DIR, file), "utf8");
  const lines = source.split("\n");

  const header: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#")) header.push(line.replace(/^#\s?/, ""));
    else break;
  }

  // The `on:` block: the `on:` line plus every following indented line.
  const triggers: string[] = [];
  const start = lines.findIndex((line) => /^on:/.test(line));
  if (start >= 0) {
    triggers.push(lines[start]);
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      triggers.push(line);
    }
  }

  // Jobs: keys indented by two spaces under the top-level `jobs:`.
  const jobs = new Map<string, string>();
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt >= 0) {
    let current: string | undefined;
    let block: string[] = [];
    const flush = () => {
      if (current) jobs.set(current, block.join("\n"));
    };
    for (const line of lines.slice(jobsAt + 1)) {
      if (/^\S/.test(line)) break; // next top-level key
      const key = line.match(/^ {2}([\w-]+):\s*$/);
      if (key) {
        flush();
        current = key[1];
        block = [];
      } else if (current) {
        block.push(line);
      }
    }
    flush();
  }

  return {
    file,
    source,
    triggers: triggers.join("\n"),
    header: header.join("\n"),
    jobs,
    code: lines.filter((line) => !line.trimStart().startsWith("#")).join("\n"),
  };
}

const workflows: Workflow[] = existsSync(WORKFLOW_DIR)
  ? readdirSync(WORKFLOW_DIR)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort()
      .map(parse)
  : [];

const hasTrigger = (workflow: Workflow, trigger: string): boolean =>
  new RegExp(`(^|[\\s\\[,])${trigger}\\s*(:|,|\\]|$)`, "m").test(workflow.triggers);

const scheduled = workflows.filter((workflow) => hasTrigger(workflow, "schedule"));

// A job-level `if:` is a 4-space-indented key of the job (a step's `if:` sits
// deeper, under `steps:`).
const jobLevelIf = (block: string): string | undefined =>
  block.match(/^ {4}if:[ \t]*(.*)$/m)?.[1];

describe("scheduled workflows are inert until an agent is configured", () => {
  it("finds at least two scheduled workflows (the checks below are not vacuous)", () => {
    expect(scheduled.map((workflow) => workflow.file)).toEqual(
      expect.arrayContaining(["health-check.yml", "sandbox-health.yml"]),
    );
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
    for (const workflow of scheduled) expect(workflow.jobs.size).toBeGreaterThan(0);
  });

  it("gates EVERY job of every scheduled workflow on vars.EVE_HEALTH_URL", () => {
    const ungated: string[] = [];
    for (const workflow of scheduled) {
      for (const [job, block] of workflow.jobs) {
        const condition = jobLevelIf(block);
        if (!condition || !/vars\.EVE_HEALTH_URL\s*!=\s*''/.test(condition)) {
          ungated.push(`${workflow.file} job "${job}" (job-level if: ${condition ?? "missing"})`);
        }
      }
    }
    expect(ungated).toEqual([]);
  });

  it("says in its header that it is inert until vars.EVE_HEALTH_URL is set", () => {
    const silent: string[] = [];
    for (const workflow of scheduled) {
      const header = workflow.header.replace(/\s+/g, " ");
      if (!/inert until `vars\.EVE_HEALTH_URL` is set/i.test(header)) silent.push(workflow.file);
    }
    expect(silent).toEqual([]);
  });
});

describe("workflows that run on pull_request or push", () => {
  const checked = workflows.filter(
    (workflow) => hasTrigger(workflow, "pull_request") || hasTrigger(workflow, "push"),
  );

  it("exist (the CI workflow is found)", () => {
    expect(checked.map((workflow) => workflow.file)).toContain("ci.yml");
  });

  it("need no secret and no repository variable to be green on a fresh copy", () => {
    const needy: string[] = [];
    for (const workflow of checked) {
      // `secrets.GITHUB_TOKEN` is provisioned by GitHub on every repo.
      const refs = [...workflow.code.matchAll(/\b(secrets|vars)\.([A-Za-z_][\w]*)/g)]
        .map((match) => `${match[1]}.${match[2]}`)
        .filter((ref) => ref !== "secrets.GITHUB_TOKEN");
      if (refs.length > 0) needy.push(`${workflow.file}: ${[...new Set(refs)].join(", ")}`);
    }
    expect(needy).toEqual([]);
  });
});
