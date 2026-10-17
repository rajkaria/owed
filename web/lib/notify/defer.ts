import "server-only";
import { after } from "next/server";

// W3-A: webhook work never holds a response. Inside a request (route handler, page render) it runs
// after the response is sent, for as long as the route's maxDuration allows (Vercel's waitUntil).
// Outside one (scripts, tests) it runs in the background and `drain()` waits for it.
// A failure is logged and swallowed: watching a request never fails creating or settling it.

const running = new Set<Promise<void>>();

export function defer(label: string, task: () => Promise<unknown>): void {
  const run = async () => {
    try {
      await task();
    } catch (e) {
      console.warn(`helius: ${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  try {
    after(run);
    return;
  } catch {
    // Not inside a request scope.
  }
  const p = run();
  running.add(p);
  void p.finally(() => running.delete(p));
}

/** Resolves once every background task started outside a request (and any they started) is done. */
export async function drain(): Promise<void> {
  while (running.size) await Promise.all([...running]);
}
