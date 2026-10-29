import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Gate against the eve APIs removed by its pre-1.0 cleanup. Unwrapped
// connection exports and a plain-object `agent.ts` export already fail
// `pnpm typecheck` and `pnpm build`, so they are covered by the phase check
// (`pnpm typecheck && pnpm test && pnpm build`), not by this test.

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "../..");

const SKIPPED_DIRS = new Set(["node_modules", ".git", ".output", ".eve", ".nitro"]);

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

function filesUnder(dirs: string[], extension?: string): string[] {
  return dirs
    .flatMap((dir) => listFiles(join(ROOT, dir)))
    .filter((file) => file !== SELF)
    .filter((file) => (extension ? file.endsWith(extension) : true));
}

function offenders(files: string[], patterns: RegExp[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        found.push(`${relative(ROOT, file)} matches ${pattern}`);
      }
    }
  }
  return found;
}

describe("removed eve APIs", () => {
  it("no source file uses an API removed by eve's pre-1.0 cleanup", () => {
    const removed = [
      /\.reset\(/,
      /thresholdPercent/,
      /streamReconnectPolicy/,
      /experimental_runDiscordGatewayRelay/,
    ];
    expect(offenders(filesUnder(["agent", "evals"], ".ts"), removed)).toEqual([]);

    // A sandbox is declared by `agent/sandbox.ts` OR an `agent/sandbox/`
    // directory, never both.
    const hasFile = existsSync(join(ROOT, "agent", "sandbox.ts"));
    const hasDir = existsSync(join(ROOT, "agent", "sandbox"));
    expect(hasFile && hasDir).toBe(false);
  });

  it("no deprecated API or unverified marker remains", () => {
    const markers = [
      /createVercelSandbox/,
      /not re-verified/,
      /TODO verify/,
      /FIXME verify/,
    ];
    const files = filesUnder(["agent", "evals", "scripts", "docs"]);
    expect(files.length).toBeGreaterThan(0);
    expect(offenders(files, markers)).toEqual([]);
  });
});
