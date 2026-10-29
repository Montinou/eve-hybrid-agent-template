// eve's bundler inlines @ai-sdk/harness-claude-code's CODE but not its bridge
// DATA files (package.json, pnpm-lockfile.yaml, pnpm-workspace.yaml, index.mjs
// in dist/bridge/ — the list readBridgeAsset() maps in the package's
// dist/index.js), which readBridgeAsset()
// loads at runtime relative to the bundled module that contains it
// (e.g. /var/task/_chunks/bridge/ in the current eve build).
// Without this step, any harness-backed tool fails at runtime with ENOENT.
// That's why the build script is `eve build && node scripts/copy-bridge-assets.mjs`
// — NEVER bare `eve build` (gotcha 2 in the hybrid-agent pattern).
//
// Two output layouts exist and we must hit the one that actually deploys:
//  - Local `eve build` / self-host: .output/server/  (Nitro tree)
//  - Vercel remote build:           .vercel/output/functions/<fn>.func/
//    — the .func dir is what becomes /var/task at runtime. A fix that only
//    targets .output/ passes its own check against the NON-deployed tree and
//    still ships a broken bundle.
//
// Local layout note: per eve's deployment guide, `eve build` only writes
// `.vercel/output` when the `VERCEL` env var is set (every hosted Vercel
// build sets it) — a plain local `eve build` skips that bundle entirely and
// produces only `.output/`. So the hard-fail-if-missing-libs-dir check under
// `.vercel/output/functions` is gated on `process.env.VERCEL` — it's the
// hosted-build case where a Vercel Build Output tree without bridge assets
// must never ship. Locally (`VERCEL` unset), the `.vercel/output` tree simply
// won't exist, and that's expected, not an error; we still always handle the
// `.output/server` tree unconditionally when present.
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The project root: the script's parent directory, or an explicit path as
// the first argument (agent/lib/copy-bridge-assets.test.ts runs it against
// a fixture tree).
const root = process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules/@ai-sdk/harness-claude-code/dist/bridge");

if (!existsSync(src)) {
  console.error(`[copy-bridge-assets] source missing: ${src}`);
  process.exit(1);
}

// Every bundled module that loads the bridge resolves `./bridge/<asset>`
// against its OWN directory (`new URL("./bridge/...", import.meta.url)` in
// @ai-sdk/harness-claude-code's dist/index.js), so the assets must sit beside
// each such module — wherever the bundler put it. Older eve builds put it under
// `_libs/`; the current one inlines it into `_chunks/node-server.mjs`. Locating the
// referencing modules instead of hard-coding a directory survives the next
// bundler layout change.
const BRIDGE_ASSETS = ["package.json", "pnpm-lockfile.yaml", "pnpm-workspace.yaml", "index.mjs"];
const BRIDGE_MARKER = '"./bridge/pnpm-lockfile.yaml"';

function copyTo(dir) {
  const dest = join(dir, "bridge");
  cpSync(src, dest, { recursive: true });
  for (const f of BRIDGE_ASSETS) {
    if (!existsSync(join(dest, f))) {
      console.error(`[copy-bridge-assets] missing after copy: ${join(dest, f)}`);
      process.exit(1);
    }
  }
  console.log(`[copy-bridge-assets] bridge assets → ${dest}`);
}

/** Directories (under `tree`) holding a bundled module that loads the bridge. */
function findBridgeReferrerDirs(tree, depth = 0) {
  if (depth > 6 || !existsSync(tree)) return [];
  const results = new Set();
  for (const entry of readdirSync(tree)) {
    const full = join(tree, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "bridge" || entry === "node_modules") continue;
      for (const d of findBridgeReferrerDirs(full, depth + 1)) results.add(d);
    } else if (entry.endsWith(".mjs") || entry.endsWith(".js")) {
      if (readFileSync(full, "utf8").includes(BRIDGE_MARKER)) results.add(tree);
    }
  }
  return [...results];
}

function findFuncDirs(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry.endsWith(".func")) results.push(full);
    else results.push(...findFuncDirs(full, depth + 1));
  }
  return results;
}

let copies = 0;

// Vercel Build Output API tree — the deployable artifact on remote builds.
// Only present when `eve build` ran with `VERCEL` set (hosted builds and
// linked local `vercel build` runs); see the file-level comment above.
const vercelFns = join(root, ".vercel/output/functions");
if (existsSync(vercelFns)) {
  const funcDirs = findFuncDirs(vercelFns);
  const targets = funcDirs.flatMap((d) => findBridgeReferrerDirs(d));
  if (targets.length === 0) {
    if (process.env.VERCEL) {
      console.error(
        `[copy-bridge-assets] ${vercelFns} exists but no *.func module loads the bridge — refusing to ship a bundle without bridge assets`,
      );
      process.exit(1);
    }
    console.warn(
      `[copy-bridge-assets] ${vercelFns} exists but no *.func module loads the bridge — skipping (VERCEL unset, not a hosted build)`,
    );
  } else {
    for (const d of targets) copyTo(d);
    copies += targets.length;

    // Fixup: eve sets the workflow function to maxDuration 'max' but leaves the
    // server function at the 300s default — raise it so channel-side turns get
    // the same headroom (Pro GA cap).
    for (const funcDir of funcDirs) {
      if (findBridgeReferrerDirs(funcDir).length === 0) continue;
      const vcConfig = join(funcDir, ".vc-config.json");
      if (!existsSync(vcConfig)) continue;
      const config = JSON.parse(readFileSync(vcConfig, "utf8"));
      if (config.maxDuration === undefined) {
        config.maxDuration = 800;
        writeFileSync(vcConfig, JSON.stringify(config));
        console.log(`[copy-bridge-assets] maxDuration=800 → ${vcConfig}`);
      }
    }
  }
}

// Nitro tree — local eve start / preview.
const nitroServer = join(root, ".output/server");
if (existsSync(nitroServer)) {
  const targets = findBridgeReferrerDirs(nitroServer);
  if (targets.length === 0) {
    console.error(
      `[copy-bridge-assets] ${nitroServer} exists but no bundled module loads the bridge — did the bundle layout change?`,
    );
    process.exit(1);
  }
  for (const d of targets) copyTo(d);
  copies += targets.length;
}

if (copies === 0) {
  console.error(
    "[copy-bridge-assets] no output tree found (.vercel/output or .output) — did eve build run?",
  );
  process.exit(1);
}
