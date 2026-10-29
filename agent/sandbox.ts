import { DefaultSandbox, defineSandbox } from "eve/sandbox";
import {
  resolveSandboxSnapshotExpirationMs,
  resolveSandboxTimeoutMs,
} from "./lib/sandbox-config.ts";

// This is eve's OWN per-session channel sandbox — a DIFFERENT lifecycle from
// the harness template/fork sandboxes managed by agent/lib/dev-agent.ts.
// See docs/06-sandbox-lifecycle.md for the two-lifecycle picture.
//
// Why the post-open git setup exists (gotcha 9): the GitHub channel's
// checkout runs git inside this sandbox, where /workspace is created by the
// platform under a different uid (1001) than the uid commands run as (root,
// HOME=/root), so git aborts every checkout with "detected dubious ownership
// in repository at '/workspace'" — observed in production; the turn
// continues WITHOUT a working tree and the failure is easy to miss. The
// selector below runs when a session first opens its sandbox, before any
// turn's checkout, so marking the workspace safe there is exactly what git's
// own error message prescribes.
//
// NOTE: per node_modules/eve/docs/sandbox/index.mdx §Lifecycle, editing this
// file (sandbox source) produces a new environment GENERATION: new sessions
// use it, while existing durable sessions keep their sandbox (its identity
// comes from the session key alone).
//
// `environment` must be exported: `eve build` prepares immutable environment
// inputs before a session exists (node_modules/eve/docs/sandbox/index.mdx
// §Define an environment).
export const environment = DefaultSandbox.environment({
  // Vercel create options (VercelSandboxCreateOptions), used only when eve
  // selects Vercel (always, on a Vercel deployment). eve forwards them to
  // every fresh sandbox it creates: the build-time template and each session
  // sandbox at first creation; resume creates nothing, so they do not apply
  // there (node_modules/eve/dist/src/public/sandbox/vercel-sandbox.d.ts).
  //
  // - timeout: @vercel/sandbox's `timeout`, a HARD LIFETIME ("Timeout in
  //   milliseconds before the sandbox auto-terminates"), not an idle
  //   timeout: activity does not reset it. Session sandboxes are
  //   persistent, so a terminated one resumes from its saved filesystem on
  //   the next access; only a command still running at that moment is lost.
  //   Default 30 minutes (eve's own default), never below one tool-call step
  //   (800s). Override via SANDBOX_TIMEOUT_MS (old name SANDBOX_IDLE_TIMEOUT_MS
  //   still accepted). See resolveSandboxTimeoutMs.
  // - snapshotExpiration: @vercel/sandbox's default expiration for snapshots
  //   created for the sandbox. Default 7 days, which covers the typical
  //   active life of a PR thread. Override via SANDBOX_SNAPSHOT_EXPIRATION_MS.
  //   It also applies to the TEMPLATE snapshot `eve build` records, and "the
  //   runtime never recreates a template": once that snapshot lapses, new
  //   sessions fail until you run the build again and redeploy
  //   (node_modules/eve/docs/sandbox/troubleshooting.mdx).
  //
  // Both resolvers live in ./lib/sandbox-config.ts (pure functions, tested
  // in sandbox-config.test.ts) rather than inline here, because this module
  // calls DefaultSandbox.environment/defineSandbox at import time, which
  // makes testing env-var resolution by importing this file directly awkward.
  vercel: {
    timeout: resolveSandboxTimeoutMs(),
    snapshotExpiration: resolveSandboxSnapshotExpirationMs(),
  },
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  // Gotcha 9 fix — without this, every channel checkout fails with git's
  // "dubious ownership" error (see the file-level comment above). eve reruns
  // this selector until initialization succeeds, so it must be safe to
  // repeat: a repeated `--add` only appends a duplicate entry, which git
  // treats the same as one.
  await sandbox.run({
    command: "git config --global --add safe.directory /workspace",
  });
  // CUSTOMIZE: add any other per-session setup your channel turns need
  // (network policy, extra git config, per-user credentials derived from
  // the selector's `session`). Keep it cheap and repeat-safe — it runs when
  // a durable session first opens its sandbox.
  return sandbox;
});
