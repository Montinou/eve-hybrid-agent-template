---
cron: "0 7 * * *"
---

Daily sandbox template maintenance (07:00 UTC — Vercel evaluates schedule crons in UTC). Call the `warm_sandbox` tool exactly once and then finish — do not deliver any message anywhere.

Why this exists: keeping the dev-agent estate template freshly warmed means each run's incremental git sync stays small (instead of a growing delta as default branches drift), the template snapshot never hits its expiration (`TEMPLATE_SNAPSHOT_EXPIRATION_MS`, default 7 days — which would force the next run to pay a full cold rebuild), and the warm's built-in sweeps (stale prior-identity templates + orphaned fork snapshots) run at least once a day even on days with no traffic.
