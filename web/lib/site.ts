import { headers } from "next/headers";

function origin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Public origin for links that must work outside a request (metadata base, build time). */
export function siteOrigin(): string {
  return (
    origin(process.env.OWED_BASE_URL) ??
    origin(process.env.VERCEL_PROJECT_PRODUCTION_URL) ??
    "http://localhost:3000"
  );
}

/**
 * Origin for links shown on a page: OWED_BASE_URL when set (so copied links
 * match what the plugin shares), otherwise the host the page was served from.
 */
export async function requestOrigin(): Promise<string> {
  const configured = origin(process.env.OWED_BASE_URL);
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) {
    const forwarded = h.get("x-forwarded-proto");
    const proto =
      forwarded === "http" || forwarded === "https"
        ? forwarded
        : /^(localhost|127\.0\.0\.1)(:|$)/.test(host)
          ? "http"
          : "https";
    return `${proto}://${host}`;
  }
  return siteOrigin();
}
