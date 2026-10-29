import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

// The standard eve channel: the framework's default HTTP API for chat and
// programmatic access. It is what the terminal UI (`eve dev`), `useEveAgent`
// frontends, curl, evals and any SDK client talk to. Even without this file
// eve mounts the same routes with `[vercelOidc(), localDev()]` — the file
// exists so the auth policy is explicit and swappable.
//
// Routes it exposes (see node_modules/eve/docs/channels/eve.mdx):
//   GET  /eve/v1/health                      always public
//   GET  /eve/v1/info                        operator principals only (service,
//                                            runtime, or localDev()); others get 403
//   POST /eve/v1/session                     start a session
//   POST /eve/v1/session/:id                 follow-up message
//   POST /eve/v1/session/:id/cancel          cancel the in-flight turn
//   GET  /eve/v1/session/:id/stream          NDJSON event stream
//
// AUTH — CUSTOMIZE BEFORE GOING PUBLIC. The defaults below admit local dev
// and Vercel-internal callers only; they never admit browser users or
// external clients in production. For a public app, prepend your own AuthFn
// (Clerk, Auth.js, an API-key verifier, your OIDC/JWT check) to this list.
// See node_modules/eve/docs/guides/auth-and-route-protection.
export default eveChannel({
  auth: [vercelOidc(), localDev()],
  // Enable CORS only if a browser frontend calls this channel directly:
  // cors: { origin: "https://app.example.com", methods: ["GET", "POST"] },
});
