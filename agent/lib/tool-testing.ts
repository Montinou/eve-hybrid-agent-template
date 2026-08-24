import type { ToolContext } from "eve/tools";

/**
 * Test-only adapter that narrows a tool's declared return type back to the
 * value our tools actually produce.
 *
 * Since eve 0.44 `defineTool`'s execute may return `TOutput`, a promise of it,
 * OR an `AsyncIterable<TOutput>` (streaming/incremental results), so the type
 * a caller sees is that whole union and every property access on it is a type
 * error. Tools in this pattern return a single settled object — the capability
 * result contract — so tests wrap the tool once here instead of casting at
 * every call site.
 *
 * The async-iterable branch is not dead code paranoia: it keeps this helper
 * correct if a tool ever does start streaming, by folding the stream to its
 * LAST yielded value, which is the settled result under that contract.
 */
type SettledOutput<TReturn> = Exclude<Awaited<TReturn>, AsyncIterable<unknown>>;

export function asExecutor<
  TTool extends {
    execute: (input: never, ctx: ToolContext) => unknown;
  },
>(tool: TTool) {
  type Input = Parameters<TTool["execute"]>[0];
  type Output = SettledOutput<ReturnType<TTool["execute"]>>;

  return async (input: Input, ctx: ToolContext): Promise<Output> => {
    const returned = await (tool.execute as (i: Input, c: ToolContext) => unknown)(input, ctx);
    if (
      returned !== null &&
      typeof returned === "object" &&
      Symbol.asyncIterator in (returned as object)
    ) {
      let last: unknown;
      for await (const value of returned as AsyncIterable<unknown>) last = value;
      return last as Output;
    }
    return returned as Output;
  };
}
