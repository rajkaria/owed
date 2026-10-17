"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * Renders the server's UTC text first (no hydration mismatch), then the
 * viewer's local time once the page is interactive.
 */
export function LocalTime({ iso, fallback }: { iso: string; fallback: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => {
      const ms = Date.parse(iso);
      if (Number.isNaN(ms)) return fallback;
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(ms);
    },
    () => fallback,
  );
  return <time dateTime={iso}>{text}</time>;
}
