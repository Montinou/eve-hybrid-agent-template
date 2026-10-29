import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pins the documentation to the repository it describes: every script, path,
// version and environment variable the docs name must exist in the repo as
// written. A doc that drifts (a renamed script, a deleted file, a bumped
// dependency) fails here instead of misleading the next reader.

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
    const installed = (name: string): string => {
      const manifest = join(ROOT, "node_modules", name, "package.json");
      if (existsSync(manifest)) {
        return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
      }
      const deps = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };
      return deps.dependencies[name].replace(/^[\^~]/, "");
    };
    const wrong: string[] = [];
    for (const file of DOC_FILES) {
      const source = text.get(file) ?? "";
      for (const match of source.matchAll(
        /(?<![\w@/.-])(eve|ai|@ai-sdk\/[\w-]+)`?(?:@| )v?(\d+\.\d+\.\d+)(?![\w.-])/g,
      )) {
        const [, name, version] = match;
        if (version !== installed(name)) {
          wrong.push(`${rel(file)}: ${name} ${version} (installed ${installed(name)})`);
        }
      }
      const manager = pkg.packageManager.replace(/^pnpm@/, "");
      for (const match of source.matchAll(/\bpnpm[@ ](\d+(?:\.\d+\.\d+)?)(?![\w.-])/g)) {
        const named = match[1];
        if (named !== manager && !manager.startsWith(`${named}.`)) {
          wrong.push(`${rel(file)}: pnpm ${named} (packageManager ${manager})`);
        }
      }
    }
    expect(wrong).toEqual([]);
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
