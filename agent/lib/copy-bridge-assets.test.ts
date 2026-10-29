import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Post-build check for gotcha 2: @ai-sdk/harness-claude-code loads its bridge
// data files with `new URL("./bridge/<asset>", import.meta.url)`, so after
// `eve build` they must sit beside whichever bundled module contains that
// code (`_chunks/` in the current eve build, `_libs/` in older ones). These run the
// real script against a fixture tree.

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/copy-bridge-assets.mjs",
);
const ASSETS = ["package.json", "pnpm-lockfile.yaml", "pnpm-workspace.yaml", "index.mjs"];

let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function fixture(chunkDir: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-assets-"));
  const bridge = join(dir, "node_modules/@ai-sdk/harness-claude-code/dist/bridge");
  mkdirSync(bridge, { recursive: true });
  for (const f of ASSETS) writeFileSync(join(bridge, f), f);
  mkdirSync(join(dir, ".output/server/_libs"), { recursive: true });
  writeFileSync(join(dir, ".output/server/index.mjs"), "export {};\n");
  if (chunkDir !== null) {
    mkdirSync(join(dir, ".output/server", chunkDir), { recursive: true });
    writeFileSync(
      join(dir, ".output/server", chunkDir, "node-server.mjs"),
      'const a = new URL("./bridge/pnpm-lockfile.yaml", import.meta.url);\n',
    );
  }
  return dir;
}

function run(dir: string, vercel = "") {
  return spawnSync(process.execPath, [SCRIPT, dir], {
    encoding: "utf8",
    env: { ...process.env, VERCEL: vercel },
  });
}

function addFunc(dir: string, withReferrer: boolean): string {
  const func = join(dir, ".vercel/output/functions/__server.func");
  mkdirSync(join(func, "_chunks"), { recursive: true });
  writeFileSync(join(func, ".vc-config.json"), JSON.stringify({ runtime: "nodejs24.x" }));
  writeFileSync(
    join(func, "_chunks/node-server.mjs"),
    withReferrer ? 'new URL("./bridge/pnpm-lockfile.yaml", import.meta.url);\n' : "export {};\n",
  );
  return func;
}

describe("scripts/copy-bridge-assets.mjs", () => {
  it("copies the bridge beside the bundled module that loads it (current eve: _chunks)", () => {
    root = fixture("_chunks");
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    for (const f of ASSETS) {
      expect(existsSync(join(root, ".output/server/_chunks/bridge", f))).toBe(true);
    }
  });

  it("fails the build when no bundled module loads the bridge", () => {
    root = fixture(null);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no bundled module loads the bridge");
  });

  it("copies into every bundled directory that loads the bridge", () => {
    root = fixture("_chunks");
    mkdirSync(join(root, ".output/server/_libs/harness"), { recursive: true });
    writeFileSync(
      join(root, ".output/server/_libs/harness/index.mjs"),
      'new URL("./bridge/pnpm-lockfile.yaml", import.meta.url);\n',
    );
    expect(run(root).status).toBe(0);
    expect(existsSync(join(root, ".output/server/_chunks/bridge/index.mjs"))).toBe(true);
    expect(existsSync(join(root, ".output/server/_libs/harness/bridge/index.mjs"))).toBe(true);
  });

  it("hosted build: copies beside the .func module and raises maxDuration to 800", () => {
    root = fixture("_chunks");
    const func = addFunc(root, true);
    const result = run(root, "1");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(func, "_chunks/bridge/pnpm-lockfile.yaml"))).toBe(true);
    const config = JSON.parse(readFileSync(join(func, ".vc-config.json"), "utf8"));
    expect(config.maxDuration).toBe(800);
  });

  it("hosted build: refuses to ship a .func tree where no module loads the bridge", () => {
    root = fixture("_chunks");
    addFunc(root, false);
    const result = run(root, "1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to ship");
  });
});
