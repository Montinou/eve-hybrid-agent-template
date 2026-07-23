// eve's bundler inlines @ai-sdk/harness-claude-code's CODE but not its bridge
// DATA files (package.json, pnpm-lock.yaml, index.mjs), which readBridgeAsset()
// loads at runtime relative to the bundled module (/var/task/_libs/bridge/).
// Without this step, any harness-backed tool fails at runtime with ENOENT.
// That's why the build script is `eve build && node scripts/copy-bridge-assets.mjs`
// — NEVER bare `eve build` (gotcha 2 in the hybrid-agent pattern).
//
// Two output layouts exist and we must hit the one that actually deploys:
//  - Local `eve build` / self-host: .output/server/  (Nitro tree)
//  - Vercel remote build:           .vercel/output/functions/<fn>.func/
//    — the .func dir is what becomes /var/task at runtime. A fix that only
//    targets .output/ passes its own check against the NON-deployed tree and
//    still ships a broken bundle (found the hard way in the reference
//    implementation).
//
// Local layout note: per eve's deployment guide, `eve build` only writes
// `.vercel/output` when the `VERCEL` env var is set (every hosted Vercel
// build sets it) — a plain local `eve build` skips that bundle entirely and
// produces only `.output/`. So the hard-fail-if-missing-libs-dir check under
// `.vercel/output/functions` is gated on `process.env.VERCEL` — it's the
// hosted-build case where a Vercel Build Output tree without bridge assets
// must never ship. Locally (`VERCEL` unset), the `.vercel/output` tree simply
// won't exist, and that's expected, not an error; we still always handle the
// `.output/server/_libs` tree unconditionally when present.
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

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "node_modules/@ai-sdk/harness-claude-code/dist/bridge");

if (!existsSync(src)) {
  console.error(`[copy-bridge-assets] source missing: ${src}`);
  process.exit(1);
}

function copyTo(libsDir) {
  const dest = join(libsDir, "bridge");
  cpSync(src, dest, { recursive: true });
  for (const f of ["package.json", "pnpm-lock.yaml", "index.mjs"]) {
    if (!existsSync(join(dest, f))) {
      console.error(`[copy-bridge-assets] missing after copy: ${join(dest, f)}`);
      process.exit(1);
    }
  }
  console.log(`[copy-bridge-assets] bridge assets → ${dest}`);
}

function findFuncLibsDirs(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (entry.endsWith(".func")) {
      const libs = join(full, "_libs");
      if (existsSync(libs)) results.push(libs);
    } else {
      results.push(...findFuncLibsDirs(full, depth + 1));
    }
  }
  return results;
}

let copies = 0;

// Vercel Build Output API tree — the deployable artifact on remote builds.
// Only present when `eve build` ran with `VERCEL` set (hosted builds and
// linked local `vercel build` runs); see the file-level comment above.
const vercelFns = join(root, ".vercel/output/functions");
if (existsSync(vercelFns)) {
  const libsDirs = findFuncLibsDirs(vercelFns);
  if (libsDirs.length === 0) {
    if (process.env.VERCEL) {
      console.error(
        `[copy-bridge-assets] ${vercelFns} exists but no *.func/_libs dir found — refusing to ship a bundle without bridge assets`,
      );
      process.exit(1);
    }
    console.warn(
      `[copy-bridge-assets] ${vercelFns} exists but no *.func/_libs dir found — skipping (VERCEL unset, not a hosted build)`,
    );
  } else {
    for (const libs of libsDirs) copyTo(libs);
    copies += libsDirs.length;

    // Fixup: eve sets the workflow function to maxDuration 'max' but leaves the
    // server function at the 300s default — raise it so channel-side turns get
    // the same headroom (Pro GA cap).
    for (const libs of libsDirs) {
      const vcConfig = join(dirname(libs), ".vc-config.json");
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
const nitroLibs = join(root, ".output/server/_libs");
if (existsSync(nitroLibs)) {
  copyTo(nitroLibs);
  copies += 1;
}

if (copies === 0) {
  console.error(
    "[copy-bridge-assets] no output tree found (.vercel/output or .output) — did eve build run?",
  );
  process.exit(1);
}
