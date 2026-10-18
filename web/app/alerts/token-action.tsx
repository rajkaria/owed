"use client";

import { useState } from "react";
import { AlertIcon, CheckIcon } from "@/components/icons";

/**
 * The one button on /alerts/confirm and /alerts/unsubscribe. Opening those pages changes nothing (mail scanners open
 * every link); only this POST does.
 */
export function TokenAction({ endpoint, token, label, done }: { endpoint: string; token: string; label: string; done: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setState("busy");
    setError(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        cache: "no-store",
      });
      if (res.ok) {
        setState("done");
        return;
      }
      const json = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      setError(typeof json?.error?.message === "string" ? json.error.message : `Owed answered HTTP ${res.status}; try again in a minute.`);
    } catch {
      setError("Couldn't reach Owed. Check your connection and try again.");
    }
    setState("idle");
  }

  if (state === "done") {
    return (
      <p role="status" className="inline-flex items-center gap-2 rounded-xl bg-paid-soft px-4 py-3 font-medium text-paid">
        <CheckIcon width={18} height={18} className="shrink-0" />
        {done}
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      <div>
        <button
          type="button"
          onClick={run}
          disabled={state === "busy"}
          className="inline-flex h-12 items-center rounded-xl bg-fg px-5 font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {state === "busy" ? "One moment…" : label}
        </button>
      </div>
      {error && (
        <p role="alert" className="flex gap-3 rounded-xl border border-warn-line bg-warn-soft px-4 py-3 text-sm leading-relaxed text-fg">
          <AlertIcon className="mt-0.5 shrink-0 text-warn" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
