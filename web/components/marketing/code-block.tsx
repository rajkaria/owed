import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { CopyIcon } from "@/components/icons";

// Code samples for the developer band (ink in both colour schemes, so only ink tokens are used).
// Highlighting is a small tokenizer run on the server over static strings: no dependency, no client JS.

type Lang = "json" | "shell" | "text";

const KEY = "text-ink-fg";
const STR = "text-ink-accent";
const NUM = "text-[#ffcf70]";
const LIT = "text-[#c4b5fd]";
const PUN = "text-ink-muted";
const CMT = "italic text-ink-muted";
const URL = "text-ink-fg";

function span(cls: string, text: string, key: number): ReactNode {
  return (
    <span key={key} className={cls}>
      {text}
    </span>
  );
}

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)|\b(true|false|null)\b|(\/\/[^\n]*)/g;

function highlightJson(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of code.matchAll(JSON_TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(span(PUN, code.slice(last, i), k++));
    if (m[1] !== undefined) {
      out.push(span(KEY, m[1], k++));
      out.push(span(PUN, m[2], k++));
    } else if (m[3] !== undefined) out.push(span(STR, m[3], k++));
    else if (m[4] !== undefined) out.push(span(NUM, m[4], k++));
    else if (m[5] !== undefined) out.push(span(LIT, m[5], k++));
    else if (m[6] !== undefined) out.push(span(CMT, m[6], k++));
    last = i + m[0].length;
  }
  if (last < code.length) out.push(span(PUN, code.slice(last), k++));
  return out;
}

const SHELL_TOKEN = /(#[^\n]*)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(\s--?[A-Za-z][\w-]*)|(https?:\/\/\S+|solana:\S+)|(^|\n)(\s*)(curl|HTTP\/2 \d{3})/g;

function highlightShell(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of code.matchAll(SHELL_TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(span(PUN, code.slice(last, i), k++));
    if (m[1] !== undefined) out.push(span(CMT, m[1], k++));
    else if (m[2] !== undefined) out.push(span(STR, m[2], k++));
    else if (m[3] !== undefined) out.push(span(NUM, m[3], k++));
    else if (m[4] !== undefined) out.push(span(URL, m[4], k++));
    else {
      out.push(span(PUN, `${m[5]}${m[6]}`, k++));
      out.push(span(m[7].startsWith("HTTP") ? NUM : KEY, m[7], k++));
    }
    last = i + m[0].length;
  }
  if (last < code.length) out.push(span(PUN, code.slice(last), k++));
  return out;
}

export function highlight(code: string, lang: Lang): ReactNode[] {
  if (lang === "json") return highlightJson(code);
  if (lang === "shell") return highlightShell(code);
  return [span(KEY, code, 0)];
}

export function CodeBlock({
  code,
  lang = "text",
  title,
  copy = true,
  className = "",
}: {
  code: string;
  lang?: Lang;
  /** Label in the block's title bar, e.g. a file name or "request". */
  title: string;
  copy?: boolean;
  className?: string;
}) {
  return (
    <figure className={`min-w-0 overflow-hidden rounded-xl border border-ink-line bg-ink-sunken ${className}`}>
      <figcaption className="flex items-center justify-between gap-3 border-b border-ink-line px-4 py-2">
        <span className="font-mono text-xs text-ink-muted">{title}</span>
        {copy && (
          <CopyButton
            text={code}
            label="Copy"
            icon={<CopyIcon width={14} height={14} className="shrink-0" />}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-ink-muted hover:bg-ink-accent-soft hover:text-ink-fg"
          />
        )}
      </figcaption>
      <pre className="overflow-x-auto p-4 font-mono text-[0.8125rem] leading-relaxed text-ink-fg" tabIndex={0}>
        <code>{highlight(code, lang)}</code>
      </pre>
    </figure>
  );
}
