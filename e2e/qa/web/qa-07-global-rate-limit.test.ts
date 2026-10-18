// QA-07 (Medium): the global create budget (CREATE_LIMITS.globalPerHour = 600) is one shared bucket and
// recipients cost nothing, so one client spreading 600 creates over 10 throwaway wallets (60 each, or
// 30 twenty-person splits) makes POST /requests, /groups and /invoices answer 429 for everyone for up
// to an hour: the plugin's ask_for_money/split_bill/create_invoice refuse ("Owed is limiting new
// requests for this wallet right now"), the demo and judges included. Not run against production
// (it would take production down); this test runs the real route on PGlite.
// Owner: W2-E (web/lib/ratelimit.ts). The exact policy is the owner's (per-IP bucket for non-PayBox
// clients, a Vercel Firewall rate-limit rule, a bigger global cap…); the test only asks that one client
// can't spend everyone's budget. Run: command node e2e/qa/run.mjs QA-07
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { POST } from "@/app/api/v1/requests/route";
import { hasPglite, startDb } from "./qa-harness.ts";

const it = hasPglite ? test : test.skip;
before(startDb);

// A fresh on-curve wallet address: an ed25519 public key in base58 (no bare imports from outside web/).
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function newWallet(): string {
  const der = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  let n = BigInt(`0x${Buffer.from(der.subarray(-32)).toString("hex")}`);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return out;
}

const create = (recipient: string, ip: string) => POST(new Request("https://www.getowed.xyz/api/v1/requests", {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": ip, "x-real-ip": ip, "x-vercel-forwarded-for": ip },
  body: JSON.stringify({ recipient, amount: "0.01", source: "web" }),
}));

it("QA-07 600 creates from one client over 10 wallets don't lock out a different client", { timeout: 600_000 }, async () => {
  const wallets = Array.from({ length: 10 }, () => newWallet());
  let created = 0;
  for (const w of wallets) {
    for (let i = 0; i < 60; i++) if ((await create(w, "203.0.113.7")).status === 201) created++;
  }
  assert.ok(created > 0, "precondition: the attacker's creates went through at first");
  const victim = await create(newWallet(), "198.51.100.9");
  assert.equal(victim.status, 201, `a different client gets ${victim.status}: ${await victim.text()}`);
});
