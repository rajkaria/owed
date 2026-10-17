"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon } from "./icons";

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

export function CopyButton({
  text,
  label,
  copiedLabel = "Copied",
  icon,
  className = "",
}: {
  text: string;
  label: string;
  copiedLabel?: string;
  icon?: ReactNode;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = legacyCopy(text);
    }
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2200);
  }

  return (
    <button type="button" onClick={copy} className={className} data-state={state}>
      {state === "copied" ? <CheckIcon className="shrink-0" /> : icon}
      <span aria-live="polite">{state === "copied" ? copiedLabel : state === "failed" ? "Copy failed" : label}</span>
    </button>
  );
}
