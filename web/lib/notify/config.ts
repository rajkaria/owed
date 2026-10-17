import "server-only";

// W3-A paid-request webhooks: configuration from the environment (names only; Raj sets the values).
//   HELIUS_API_KEY         Helius account that owns the webhook (lib/solana.ts also reads through Helius first when set)
//   HELIUS_WEBHOOK_SECRET  Helius sends it back in the Authorization header of every delivery
// Either one missing turns the watch off: requests are created and settled exactly as before.

export const HOOK_PATH = "/api/hooks/helius";

const env = (name: string): string | null => process.env[name]?.trim() || null;

export interface HeliusConfig {
  apiKey: string;
  secret: string;
}

export function heliusConfig(): HeliusConfig | null {
  const apiKey = env("HELIUS_API_KEY");
  const secret = env("HELIUS_WEBHOOK_SECRET");
  return apiKey && secret ? { apiKey, secret } : null;
}

/** The secret deliveries must carry; checked even when HELIUS_API_KEY is unset (deliveries still settle). */
export function webhookSecret(): string | null {
  return env("HELIUS_WEBHOOK_SECRET");
}

function origin(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Public origin Helius posts to: OWED_BASE_URL (production), else this deployment's stable Vercel URL
 * (the production domain, or the branch alias on previews), else this deployment's own URL.
 */
export function publicBase(): string | null {
  const stable = env("VERCEL_ENV") === "production" ? env("VERCEL_PROJECT_PRODUCTION_URL") : env("VERCEL_BRANCH_URL");
  return origin(env("OWED_BASE_URL")) ?? origin(stable) ?? origin(env("VERCEL_URL"));
}

export interface HookTarget {
  /** What notify_webhooks is keyed by: the public URL without any query. */
  key: string;
  /** What Helius posts to. On a protected preview it carries Vercel's automation bypass. */
  url: string;
}

/**
 * Null when Helius couldn't reach this deployment anyway: no public https origin (`next dev`), or a preview
 * behind Vercel's protection without the automation bypass. Registering those would only take one of the
 * Helius free plan's 5 webhooks and fail every delivery.
 */
export function hookTarget(): HookTarget | null {
  const base = publicBase();
  if (!base) return null;
  const { protocol, hostname } = new URL(base);
  if (protocol !== "https:" || !hostname.includes(".") || /^(localhost|127\.|0\.0\.0\.0|\[)/.test(hostname)) return null;
  const key = `${base}${HOOK_PATH}`;
  const bypass = env("VERCEL_AUTOMATION_BYPASS_SECRET");
  if (env("VERCEL_ENV") === "preview" && !bypass) return null;
  const url = bypass && env("VERCEL_ENV") !== "production" ? `${key}?x-vercel-protection-bypass=${encodeURIComponent(bypass)}` : key;
  return { key, url };
}
