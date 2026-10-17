import "server-only";
import { getRequest } from "../requests";
import { defaultDeps, ingest, settlePendingMoonpay, type CardDeps } from "./settle";
import type { MoonpayTx } from "./transaction";

const CHAIN_BUDGET_MS = 20_000;

/**
 * A verified webhook's purchase: store MoonPay's report, then check the Solana transaction it names on
 * chain, the same way a status check does (settlePendingMoonpay). Nothing here trusts the body's amounts.
 */
export async function processWebhook(tx: MoonpayTx, requestId: string, deps: CardDeps = defaultDeps()): Promise<void> {
  const row = await getRequest(requestId);
  if (!row) return;
  if ((await ingest(tx, row, deps)) !== "stored") return;
  await settlePendingMoonpay([row], { deadline: Date.now() + CHAIN_BUDGET_MS }, deps);
}
