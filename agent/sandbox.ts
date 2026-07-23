import { defaultBackend, defineSandbox } from "eve/sandbox";
import {
  resolveSandboxIdleTimeoutMs,
  resolveSandboxSnapshotExpirationMs,
} from "./lib/sandbox-config.ts";

// This is eve's OWN per-session channel sandbox — a DIFFERENT lifecycle from
// the harness template/fork sandboxes managed by agent/lib/dev-agent.ts.
// See docs/06-sandbox-lifecycle.md for the two-lifecycle picture.
//
// Why onSession exists (gotcha 9): the GitHub channel's checkout runs git
// inside this sandbox, where /workspace is created by the platform under a
// different uid (1001) than the uid commands run as (root, HOME=/root), so
// git aborts every checkout with "detected dubious ownership in repository
// at '/workspace'" — observed in production; the turn continues WITHOUT a
// working tree and the failure is easy to miss. onSession runs once per
// session, before the turn's checkout, so marking the workspace safe there
// is exactly what git's own error message prescribes.
//
// NOTE: editing this file (the sandbox source itself) is a sandbox-definition
// change, so per node_modules/eve/docs/sandbox.mdx §Lifecycle every existing
// durable session gets a *replacement* sandbox on its next turn — the next
// turn rebuilds from template and onSession runs again. Harmless here: this
// project's sessions keep no bespoke sandbox state beyond the git
// safe.directory marker below, which onSession simply re-applies.
export default defineSandbox({
  // Sandbox.create() options, typed per backend (VercelSandboxCreateOptions):
  //
  // - timeout: how long the VM may sit IDLE before the platform tears it
  //   down — an INACTIVITY timeout, not a turn-lifetime cap
  //   (node_modules/eve/docs/sandbox.mdx §Lifecycle: "the VM times out after
  //   a period of inactivity ... eve preserves the filesystem and resumes
  //   the sandbox on the next message as if nothing happened"). A running
  //   turn is never killed by this — its own activity resets the counter;
  //   only genuine dead time between turns expires. Default 5 minutes:
  //   enough to cover the model's reasoning gaps *between* tool calls within
  //   an active turn, while minimizing billed idle compute after the turn —
  //   the VM should die as soon as the work is done, not sit waiting.
  //   Expiring only costs a snapshot-resume on the next turn (same doc), not
  //   a full rebuild. Override via SANDBOX_IDLE_TIMEOUT_MS: this number is a
  //   tunable safety ceiling, never a runtime limiter.
  // - snapshotExpiration: framework-owned persistence snapshots (minted when
  //   an idle sandbox stops) expire 7 days after last use — covers the
  //   typical active life of a PR thread. Override via
  //   SANDBOX_SNAPSHOT_EXPIRATION_MS.
  //
  // Both resolvers live in ./lib/sandbox-config.ts (pure functions, tested
  // in sandbox-config.test.ts) rather than inline here, because this module
  // calls defineSandbox/defaultBackend at import time, which makes testing
  // env-var resolution by importing this file directly awkward.
  backend: defaultBackend({
    vercel: {
      timeout: resolveSandboxIdleTimeoutMs(),
      snapshotExpiration: resolveSandboxSnapshotExpirationMs(),
    },
  }),
  async onSession({ use }) {
    const sandbox = await use();
    // Gotcha 9 fix — without this, every channel checkout fails with git's
    // "dubious ownership" error (see the file-level comment above). onSession
    // runs inside getSandbox(), before the turn's checkout. Note it does NOT
    // run for sessions created before this file existed — those stay without
    // a checkout until they expire.
    await sandbox.run({
      command: "git config --global --add safe.directory /workspace",
    });
    // CUSTOMIZE: add any other per-session setup your channel turns need
    // (network policy, extra git config, per-user credentials derived from
    // ctx.session). Keep it cheap — this runs once per durable session.
  },
});
