// Live check of POST /api/v1/ledger on a deployment (needs migration 0005 on its database).
//
//   node --import ./test/setup.mjs scripts/check-ledger.ts <base-url>
//   VERCEL_SHARE_URL=<https://<preview>/?_vercel_share=…> node --import ./test/setup.mjs scripts/check-ledger.ts https://<preview>.vercel.app
//   … scripts/check-ledger.ts <base-url> --signed <file.json | ->   # also spend a real wallet signature, e.g. from PayBox
//
// Without --signed it proves the rules with a throwaway key made at run time (it holds nothing and owns
// no requests, so its ledger is empty): a fresh signature works once, the same message again is refused,
// and stale, future, mis-worded and wrong-wallet signatures are refused. With --signed {recipient,
// signed_message, signature} (as PayBox's request_wallet_sign returned it, within 5 minutes) it spends
// that signature, prints the ledger, checks it against contract/shapes.mjs, and checks the replay is refused.
// Reads nothing but the target's ledger rows; writes only signature_nonces rows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { check as checkShape, shapes } from "../../contract/shapes.mjs";
import { ErrorResponse, LedgerResponse } from "../lib/contract";

const args = process.argv.slice(2);
const base = (args[0] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: scripts/check-ledger.ts <base-url> [--signed <file.json|->] [--allow-production]");
  process.exit(2);
}
const PRODUCTION_HOSTS = ["owed-omega.vercel.app", "getowed.xyz", "www.getowed.xyz", "owed.link", "www.owed.link"];
const isProduction = PRODUCTION_HOSTS.includes(new URL(base).hostname);
if (isProduction && !args.includes("--allow-production")) {
  console.error(`${base} is production; pass --allow-production (it writes signature_nonces rows only)`);
  process.exit(2);
}
const signedArg = args.includes("--signed") ? args[args.indexOf("--signed") + 1] : undefined;

const headers: Record<string, string> = { "Content-Type": "application/json" };
if (process.env.VERCEL_BYPASS) headers["x-vercel-protection-bypass"] = process.env.VERCEL_BYPASS;
if (process.env.VERCEL_SHARE_URL) {
  const res = await fetch(process.env.VERCEL_SHARE_URL, { redirect: "manual" });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (cookies.length === 0) throw new Error(`share link did not set a cookie (HTTP ${res.status})`);
  headers.Cookie = cookies.join("; ");
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function post(body: unknown) {
  const res = await fetch(`${base}/api/v1/ledger`, { method: "POST", headers, body: JSON.stringify(body) });
  const type = res.headers.get("content-type") ?? "";
  const data: unknown = type.includes("json") ? await res.json() : await res.text();
  return { status: res.status, data };
}
async function refused(body: unknown, status: number, code: string, pattern: RegExp) {
  const r = await post(body);
  assert.equal(r.status, status, JSON.stringify(r.data));
  const e = ErrorResponse.parse(r.data);
  assert.equal(e.error.code, code);
  assert.match(e.error.message, pattern);
}

const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const key = nacl.sign.keyPair();
const throwaway = bs58.encode(key.publicKey);
const message = (at: number, who = throwaway) => `Owed ledger access for ${who} at ${iso(at)}`;
const signed = (text: string, who = throwaway) => ({
  recipient: who, signed_message: text,
  signature: Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), key.secretKey)).toString("hex"),
});

function contractShape(data: unknown) {
  const { errors, warnings } = checkShape(shapes.ledgerRes, data) as { errors: string[]; warnings: string[] };
  assert.deepEqual(errors, []);
  if (warnings.length) console.log(`     warnings: ${warnings.join("; ")}`);
  return LedgerResponse.parse(data);
}

console.log(`check-ledger · ${base}${isProduction ? " (production)" : ""} · throwaway signer ${throwaway}`);

const fresh = signed(message(Date.now()));
await step("a fresh signature opens the (empty) ledger of its own wallet", async () => {
  const r = await post(fresh);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const ledger = contractShape(r.data);
  assert.equal(ledger.recipient, throwaway);
  assert.deepEqual([ledger.open.length, ledger.paid_recently.length, ledger.totals.length], [0, 0, 0]);
});
await step("the same signed message again is refused", () => refused(fresh, 400, "invalid_input", /already used/));
await step("the same message re-encoded as base58 is refused too", () =>
  refused({ ...fresh, signature: bs58.encode(Buffer.from(fresh.signature, "hex")) }, 400, "invalid_input", /already used/));
await step("a message older than 5 minutes is refused", () => refused(signed(message(Date.now() - 6 * 60_000)), 400, "invalid_input", /more than 5 minutes old/));
await step("a message dated in the future is refused", () => refused(signed(message(Date.now() + 5 * 60_000)), 400, "invalid_input", /dated in the future/));
await step("another wording is refused", () => refused(signed(`Owed ledger for ${throwaway} at ${iso(Date.now())}`), 400, "invalid_input", /must read "Owed ledger access for/));
await step("a signature from another wallet is refused (the team wallet's ledger stays closed)", async () => {
  const team = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
  const text = message(Date.now(), team);
  await refused({ ...signed(text), recipient: team }, 400, "invalid_input", /doesn't match this message for wallet FN6G4C/);
});
await step("malformed bodies are refused with the contract error", async () => {
  await refused({}, 400, "invalid_input", /recipient/);
  await refused({ ...signed(message(Date.now())), extra: 1 }, 400, "invalid_input", /./);
});

if (signedArg) {
  const raw = signedArg === "-" ? readFileSync(0, "utf8") : readFileSync(signedArg, "utf8");
  const real = JSON.parse(raw.trim()) as { recipient: string; signed_message: string; signature: string };
  await step(`the real signature opens ${real.recipient}'s ledger`, async () => {
    const r = await post(real);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const ledger = contractShape(r.data);
    console.log(`     chain_checked ${ledger.chain_checked} · ${ledger.open.length} open · ${ledger.paid_recently.length} paid in 30 days · truncated ${ledger.truncated}`);
    for (const t of ledger.totals) console.log(`     ${t.token}: ${t.outstanding} outstanding (${t.open_count}) · ${t.received_30d} received (${t.paid_count})`);
    for (const e of [...ledger.open, ...ledger.paid_recently]) {
      console.log(`     ${e.status.padEnd(9)} ${e.id} ${e.amount} ${e.token}${e.payer_name ? ` · "${e.payer_name}"` : ""}${e.for ? ` · "${e.for}"` : ""}${e.signature ? ` · ${e.signature.slice(0, 12)}…` : ""}`);
    }
  });
  await step("the real signature again is refused", () => refused(real, 400, "invalid_input", /already used/));
}

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
