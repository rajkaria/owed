// Constants for the marketing pages (/, /proof). Public values only.

/** Canonical origin for the marketing pages' canonical links and Open Graph URLs (previews point here too). */
export const CANONICAL_ORIGIN = "https://www.getowed.xyz";

export const REPO_URL = "https://github.com/rajkaria/owed";
export const PAYBOX_MCP_URL = "https://api.paybox.sh/mcp";
export const PAYBOX_PLUGINS_URL = "https://app.paybox.sh/plugins";

/** The team's domain and the wallet its `_owed` TXT record publishes (docs/FACTS.md, Domain). */
export const DEMO_DOMAIN = "getowed.xyz";
export const TEAM_WALLET = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
/** The Solana incinerator: stands in for "someone else's wallet" in the refused example. Nobody can receive with it. */
export const SWAPPED_WALLET = "1nc1nerator11111111111111111111111111111111";

export function canonical(path: string): string {
  return new URL(path, CANONICAL_ORIGIN).toString();
}

/** Developer links shown on the landing page. */
export const LLMS_URL = "/llms.txt";
export const TESTING_URL = `${REPO_URL}/blob/main/docs/TESTING.md`;
export const FIXTURES_URL = `${REPO_URL}/tree/main/contract/fixtures`;
export const API_URL = "https://www.getowed.xyz/api/v1";
