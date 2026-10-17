// Lets `node --test` (native TypeScript stripping, Node 24) load lib/ the way Next does:
// `@/x` -> web/x, extensionless relative imports -> .ts, and `server-only` -> no-op.
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);
const EMPTY = "data:text/javascript,export {}";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
    const spec = specifier.startsWith("@/") ? new URL(specifier.slice(2), root).href : specifier;
    const local = spec.startsWith(".") || spec.startsWith("file:");
    if (!local || /\.(?:[cm]?[jt]sx?|json)$/.test(spec)) return nextResolve(spec, context);
    for (const suffix of [".ts", ".tsx", "/index.ts"]) {
      try {
        return nextResolve(spec + suffix, context);
      } catch {
        // try the next suffix
      }
    }
    return nextResolve(spec, context);
  },
});
