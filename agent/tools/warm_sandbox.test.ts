import type { ToolContext } from "eve/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asExecutor } from "../lib/tool-testing.ts";

const warmSandboxTemplate = vi.fn();
vi.mock("#lib/dev-agent.ts", () => ({ warmSandboxTemplate }));

const ctx = { abortSignal: undefined } as unknown as ToolContext;

describe("warm_sandbox", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    warmSandboxTemplate.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    // A deploy hook configured from an older version of this template must
    // never be fired by the warm (eve 0.89: "The runtime never recreates a
    // template"; repair is a redeploy, not a hook per warm).
    vi.stubEnv("EVE_DEPLOY_HOOK_URL", "https://example.invalid/deploy-hook");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchSpy.mockReset();
  });

  it("returns only the harness template result", async () => {
    warmSandboxTemplate.mockResolvedValue({ ready: true, detail: "template warm" });
    const { default: tool } = await import("./warm_sandbox.ts");
    const out = await asExecutor(tool)({}, ctx);
    expect(Object.keys(out).sort()).toEqual(["detail", "seconds", "warmed"]);
    expect(out.warmed).toBe(true);
    expect(out.detail).toBe("template warm");
  });

  it("reports a failed warm without throwing", async () => {
    warmSandboxTemplate.mockResolvedValue({ ready: false, detail: "boom" });
    const { default: tool } = await import("./warm_sandbox.ts");
    const out = await asExecutor(tool)({}, ctx);
    expect(out.warmed).toBe(false);
    expect(out.detail).toBe("boom");
  });

  it("still accepts the retired `deep` flag from older schedules", async () => {
    // Older weekly schedules call warm_sandbox({ deep: true }); the input
    // schema strips unknown keys, so those calls keep working.
    const { default: tool } = await import("./warm_sandbox.ts");
    const parsed = (tool.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    }).safeParse({ deep: true });
    expect(parsed.success).toBe(true);
  });

  it("never calls out to a deploy hook, healthy or not", async () => {
    warmSandboxTemplate.mockResolvedValue({ ready: false, detail: "boom" });
    const { default: tool } = await import("./warm_sandbox.ts");
    await asExecutor(tool)({}, ctx);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
