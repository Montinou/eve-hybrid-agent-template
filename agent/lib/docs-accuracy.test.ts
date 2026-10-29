import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pins the documentation to the repository it describes: every script, path,
// version and environment variable the docs name must exist in the repo as
// written. A doc that drifts (a renamed script, a deleted file, a bumped
// dependency) fails here instead of misleading the next reader.
//
// Environment variables are recognized in a doc in these forms (names with at
// least one underscore, so placeholders like NAME are ignored): a whole inline
// code span (`NAME` or `NAME=value`), and inside code (fenced blocks and inline
// spans) a `NAME=` assignment, `vercel env add|rm|update NAME`,
// `process.env.NAME` / `process.env["NAME"]`, `export NAME=` and `$NAME` /
// `${NAME}` references. Each must appear in .env.example, in non-test,
// non-Markdown code under agent/, scripts/, .github/ or evals/, or in the
// allow-list below.

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");

const SKIPPED_DIRS = new Set(["node_modules", ".git", ".output", ".eve", ".nitro"]);

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  const files: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

function rel(file: string): string {
  return relative(ROOT, file);
}

// The documentation set: README, the agent entry point, docs/, every packaged
// skill, the env canon and the CI configuration.
const DOC_FILES = [
  ...listFiles(join(ROOT, "README.md")),
  ...listFiles(join(ROOT, "AGENTS.md")),
  ...listFiles(join(ROOT, "docs")).filter((file) => file.endsWith(".md")),
  ...listFiles(join(ROOT, ".claude/skills")).filter((file) => file.endsWith("SKILL.md")),
  ...listFiles(join(ROOT, ".env.example")),
  ...listFiles(join(ROOT, ".github")).filter((file) => /\.ya?ml$/.test(file)),
];

const text = new Map(DOC_FILES.map((file) => [file, readFileSync(file, "utf8")]));

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  packageManager: string;
};

// The prose of a doc names commands and paths inside code: fenced blocks and
// inline backticks (Markdown), backticks and non-comment lines (YAML), and
// backticks only (.env.example, whose comments are prose).
function codeSpans(file: string): string[] {
  const source = text.get(file) ?? "";
  const spans: string[] = [];
  const withoutFences = source.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm, (_m, body) => {
    spans.push(body as string);
    return "";
  });
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) spans.push(match[1]);
  if (/\.ya?ml$/.test(file)) {
    spans.push(
      source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n"),
    );
  }
  return spans;
}

// pnpm built-ins and subcommands that are not package.json scripts.
const PNPM_BUILT_INS = new Set([
  "add",
  "approve-builds",
  "audit",
  "config",
  "create",
  "dedupe",
  "dlx",
  "env",
  "exec",
  "fetch",
  "i",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "list",
  "ls",
  "outdated",
  "pack",
  "patch",
  "prune",
  "publish",
  "rebuild",
  "remove",
  "rm",
  "self-update",
  "setup",
  "store",
  "unlink",
  "up",
  "update",
  "why",
]);

// The installed version of a dependency, falling back to the declared one.
function installed(name: string): string {
  const manifest = join(ROOT, "node_modules", name, "package.json");
  if (existsSync(manifest)) {
    return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  }
  return declared(name).replace(/^[\^~]/, "");
}

// The `overrides` entry for a package in pnpm-workspace.yaml (docs write it as
// `ai: ^7.0.157`, YAML syntax), or "" when there is none.
function overridden(name: string): string {
  const workspace = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = workspace.match(new RegExp(`^[ \\t]+["']?${escaped}["']?:[ \\t]*(\\S+)[ \\t]*$`, "m"));
  return match ? match[1] : "";
}

function declared(name: string): string {
  const deps = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  return deps.dependencies[name] ?? "";
}

// Versions a doc names for eve, ai, @ai-sdk packages and pnpm that differ from
// the repo. Accepts `name 1.2.3`, `name@1.2.3`, `name: ^1.2.3` and `name@~1.2.3`
// (an exact version is compared with the installed one; a range with the range
// package.json declares, except the YAML form `name: ^1.2.3`, which is the
// pnpm-workspace.yaml override and is compared with that), and pnpm with a
// two-part version (`pnpm 12.17`).
function wrongVersions(source: string): string[] {
  const wrong: string[] = [];
  for (const match of source.matchAll(
    /(?<![\w@/.-])(eve|ai|@ai-sdk\/[\w-]+)`?(@|:\s*| )([\^~]?)v?(\d+\.\d+\.\d+)(?![\w-]|\.\w)/g,
  )) {
    const [, name, separator, range, version] = match;
    const rangeSource = separator.startsWith(":") ? overridden(name) || declared(name) : declared(name);
    const expected = range && rangeSource ? rangeSource : installed(name);
    const named = `${range}${version}`;
    if (named !== expected && !(range === "" && version === installed(name))) {
      wrong.push(`${name} ${named} (expected ${expected})`);
    }
  }
  const manager = pkg.packageManager.replace(/^pnpm@/, "");
  for (const match of source.matchAll(/\bpnpm[@ ]v?(\d+(?:\.\d+){0,2})(?![\w-]|\.\w)/g)) {
    const named = match[1];
    if (named !== manager && !manager.startsWith(`${named}.`)) {
      wrong.push(`pnpm ${named} (packageManager ${manager})`);
    }
  }
  return wrong;
}

// Environment-variable names the docs may mention that this repo neither lists
// in .env.example nor reads in agent/, scripts/, .github/ or evals/. One reason
// per entry; anything else a doc names must exist in the repo.
const EXTERNAL_ENV_NAMES = new Map<string, string>([
  ["ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION", "pnpm's error code, quoted from its install failure"],
  ["BLOB_READ_WRITE_TOKEN", "injected by Vercel when a Blob store is added (docs/08-extensions.md)"],
  ["EVE_EVAL_AUTH_TOKEN", "read by `eve eval --url`, not by this repo (node_modules/eve/docs/evals/targets.mdx)"],
  ["AGENT_WRITE_REPOS", "read by the example code a reader adds for a write-capable capability (docs/05-dev-agent.md)"],
]);

const ENV_NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+";

// Names a Markdown doc presents as an environment variable (see the header
// comment for the forms).
function envNamesIn(source: string): string[] {
  const names: string[] = [];
  const regions: string[] = [];
  const withoutFences = source.replace(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```/gm, (_m, body) => {
    regions.push(body as string);
    return "";
  });
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    regions.push(match[1]);
    const whole = match[1].match(new RegExp(`^(${ENV_NAME})(?:=.*)?$`));
    if (whole) names.push(whole[1]);
  }
  const forms = [
    new RegExp(`(?<![\\w$.])(${ENV_NAME})=`, "g"), // NAME=value, export NAME=value
    new RegExp(`\\bvercel env (?:add|rm|update) (${ENV_NAME})\\b`, "g"),
    new RegExp(`\\bprocess\\.env(?:\\.|\\[["'])(${ENV_NAME})\\b`, "g"),
    new RegExp(`\\$\\{?(${ENV_NAME})\\b`, "g"), // $NAME, ${NAME}
  ];
  for (const region of regions) {
    for (const form of forms) {
      for (const match of region.matchAll(form)) names.push(match[1]);
    }
  }
  return names;
}

function unknownEnvNames(source: string, known: ReadonlySet<string>): string[] {
  return [...new Set(envNamesIn(source))].filter(
    (name) => !known.has(name) && !EXTERNAL_ENV_NAMES.has(name),
  );
}

// Every env-like name that appears in .env.example or in the code and CI
// configuration. Tests and Markdown are excluded, so a fixture or a skill file
// cannot vouch for a variable no code reads (this test file is a test, so it
// is excluded too: it holds the allow-list).
function knownEnvNames(): Set<string> {
  const sources = [
    join(ROOT, ".env.example"),
    ...["agent", "scripts", ".github", "evals"].flatMap((dir) => listFiles(join(ROOT, dir))),
  ].filter((file) => file === join(ROOT, ".env.example") || !/\.test\.[cm]?[jt]s$|\.md$/.test(file));
  const names = new Set<string>();
  for (const file of sources) {
    for (const match of readFileSync(file, "utf8").matchAll(new RegExp(`\\b${ENV_NAME}\\b`, "g"))) {
      names.add(match[0]);
    }
  }
  return names;
}

describe("docs accuracy helpers", () => {
  it("version check matches the range form in docs/07-ops.md and rejects a wrong one", () => {
    const ops = text.get(join(ROOT, "docs/07-ops.md")) ?? "";
    expect(ops).toMatch(/`ai: \^7\.0\.157`/); // the form the check must be able to see
    expect(wrongVersions("(`ai: ^7.0.157`)")).toEqual([]);
    expect(wrongVersions(`eve ${installed("eve")} and \`ai@${installed("ai")}\``)).toEqual([]);
    expect(wrongVersions("(`ai: ^7.0.1`)")).toHaveLength(1);
    expect(overridden("ai")).toBe("^7.0.157"); // the pnpm-workspace.yaml entry the `ai:` form describes
    expect(wrongVersions("`eve@^0.1.0`")).toHaveLength(1);
    expect(wrongVersions("run pnpm 12.17 here")).toHaveLength(1);
  });

  it("env-var check sees every supported form", () => {
    const known = new Set(["GITHUB_APP_ID"]);
    const flagged = (source: string) => unknownEnvNames(source, known);
    expect(flagged("```sh\nvercel env add GITHUB_APP_IDD production\n```")).toEqual(["GITHUB_APP_IDD"]);
    expect(flagged("run `vercel env add GITHUB_APP_IDD production < key.pem`")).toEqual(["GITHUB_APP_IDD"]);
    expect(flagged("```ts\nconst a = process.env.FOO_BAR_BAZ;\n```")).toEqual(["FOO_BAR_BAZ"]);
    expect(flagged("```ts\nconst a = process.env[\"FOO_BAR_BAZ\"];\n```")).toEqual(["FOO_BAR_BAZ"]);
    expect(flagged("```sh\nexport FOO_BAR_BAZ=1\n```")).toEqual(["FOO_BAR_BAZ"]);
    expect(flagged("```sh\nGITHUB_APP_ID=1 FOO_BAR_BAZ=$GITHUB_APP_ID pnpm x\n```")).toEqual(["FOO_BAR_BAZ"]);
    expect(flagged("```sh\necho $FOO_BAR_BAZ\n```")).toEqual(["FOO_BAR_BAZ"]);
    expect(flagged("```sh\necho ${FOO_BAR_BAZ}\n```")).toEqual(["FOO_BAR_BAZ"]);
    expect(flagged("use `X=$FOO_BAR_BAZ` here")).toEqual(["FOO_BAR_BAZ"]);
    // known names, placeholders and prose are not flagged
    expect(flagged("```sh\nvercel env add GITHUB_APP_ID production\nexport GITHUB_APP_ID=1\n```")).toEqual([]);
    expect(flagged("`vercel env add NAME production` and prose FOO_BAR_BAZ")).toEqual([]);
  });

  it("env-var check flags an unknown name and accepts a known one", () => {
    const known = new Set(["EVE_BYPASS_TOKEN"]);
    expect(unknownEnvNames("set `EVE_BYPAS_TOKEN`", known)).toEqual(["EVE_BYPAS_TOKEN"]);
    expect(unknownEnvNames("set `EVE_BYPASS_TOKEN`", known)).toEqual([]);
    expect(unknownEnvNames("```sh\nEVE_BYPAS_TOKEN=x pnpm eval\n```", known)).toEqual([
      "EVE_BYPAS_TOKEN",
    ]);
    expect(unknownEnvNames("the `ENOENT` error and `pnpm test`", known)).toEqual([]);
  });
});

describe("docs accuracy", () => {
  it("every pnpm script named in the docs exists in package.json", () => {
    const missing: string[] = [];
    for (const file of DOC_FILES) {
      for (const span of codeSpans(file)) {
        for (const match of span.matchAll(/\bpnpm (?:run )?([a-z][\w:-]*)/g)) {
          const name = match[1];
          if (PNPM_BUILT_INS.has(name)) continue;
          if (!(name in pkg.scripts)) missing.push(`${rel(file)}: pnpm ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("every repo path named in the docs exists", () => {
    const missing: string[] = [];
    for (const file of DOC_FILES) {
      const lines = (text.get(file) ?? "").split("\n");
      lines.forEach((line, index) => {
        // Paths a person is told to create or change are marked CUSTOMIZE.
        if (/CUSTOMIZE/.test(line)) return;
        for (const span of line.matchAll(/`([^`]+)`/g)) {
          for (const word of span[1].split(/\s+/)) {
            if (!/^(?:agent|docs|scripts|evals|\.github)\//.test(word)) continue;
            if (/[*<>{}]/.test(word)) continue; // globs and <placeholders>
            const path = word
              .replace(/[#:]\d*[\w-]*$/, "") // :123 line suffix, #anchor
              .replace(/[),.;]+$/, "");
            if (!existsSync(join(ROOT, path))) {
              missing.push(`${rel(file)}:${index + 1}: ${path}`);
            }
          }
        }
      });
    }
    expect(missing).toEqual([]);
  });

  it("no doc names a version of eve, ai, @ai-sdk packages or pnpm different from package.json", () => {
    const wrong: string[] = [];
    for (const file of DOC_FILES) {
      for (const message of wrongVersions(text.get(file) ?? "")) wrong.push(`${rel(file)}: ${message}`);
    }
    expect(wrong).toEqual([]);
  });

  it("every environment variable a doc names exists in .env.example, the code or the allow-list", () => {
    const known = knownEnvNames();
    expect(known.has("EVE_BYPASS_TOKEN")).toBe(true); // the check sees scripts/
    expect(known.has("GITHUB_APP_ID")).toBe(true); // and .env.example
    const unknown: string[] = [];
    let total = 0;
    for (const file of DOC_FILES.filter((f) => f.endsWith(".md"))) {
      const source = text.get(file) ?? "";
      total += envNamesIn(source).length;
      for (const name of unknownEnvNames(source, known)) unknown.push(`${rel(file)}: ${name}`);
    }
    expect(total).toBeGreaterThan(0); // an extractor that finds nothing must not pass
    const form = (file: string) => envNamesIn(text.get(join(ROOT, file)) ?? "");
    expect(form("docs/03-github-channel.md")).toContain("GITHUB_APP_ID"); // vercel env add
    expect(form("docs/05-dev-agent.md")).toContain("AGENT_WRITE_REPOS"); // process.env
    expect(form("docs/07-ops.md")).toContain("EVE_TOKEN"); // a later NAME= assignment
    expect(unknown).toEqual([]);
  });

  it("every environment variable named in .env.example is read under agent/ or documented in docs/01-prerequisites.md", () => {
    const names = [
      ...(text.get(join(ROOT, ".env.example")) ?? "").matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm),
    ].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    const agentSource = listFiles(join(ROOT, "agent"))
      .filter((file) => /\.(ts|md)$/.test(file) && !file.endsWith(".test.ts"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const prerequisites = readFileSync(join(ROOT, "docs/01-prerequisites.md"), "utf8");
    const unaccounted = names.filter(
      (name) => !agentSource.includes(name) && !prerequisites.includes(name),
    );
    expect(unaccounted).toEqual([]);
  });
});
