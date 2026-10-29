---
cron: "0 7 * * *"
---

Daily sandbox maintenance (07:00 UTC — Vercel evaluates schedule crons in UTC). Call the `warm_sandbox` tool exactly once, with no arguments, and then finish — do not deliver any message anywhere.

Why this exists: for the dev-agent's harness template, a fresh warm keeps each run's incremental git sync small (instead of a growing delta as default branches drift), keeps the template snapshot away from its expiration (`TEMPLATE_SNAPSHOT_EXPIRATION_MS` — lapsing would force the next run to pay a full cold rebuild), and runs the built-in sweeps (stale prior-identity templates + orphaned fork snapshots) at least once a day even on days with no traffic.

eve's own sandbox template is not maintained here: `eve build` records it as a snapshot and the runtime never recreates it, so a lapsed one is repaired by a redeploy, which `.github/workflows/sandbox-health.yml` tells you to do. See docs/06-sandbox-lifecycle.md.
