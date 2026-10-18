import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { POST as enterpriseHook } from "@/app/api/hooks/moonpay-enterprise/route";
import { GetRequestResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import { bankAccountPrefix, detailsHash, registerVirtualAccount } from "@/lib/moonpay/accounts";
import { processEnterpriseEvent, type BankDeps } from "@/lib/moonpay/bank";
import { bankOffer } from "@/lib/moonpay/bank-offer";
import { parseAutoramp, parseAutorampTransaction, type Autoramp, type AutorampTransaction, type EnterpriseConfig } from "@/lib/moonpay/enterprise";
import { getRequest, toPublic } from "@/lib/requests";
import { isoSeconds } from "@/lib/verify-signature";
import type { ParsedTransaction } from "@/lib/validate";
import { check, shapes } from "../../contract/shapes.mjs";

// F3 bank rail on real Postgres (every migration on PGlite): registering the recipient's virtual account with their
// wallet's signature, the invoice page's "Pay by bank transfer" offer (only with the flag on and signed details), and
// attribution of MoonPay Enterprise transactions: a unique amount is paid only after the chain confirms the USDC
// payout; a shared amount marks nothing; less marks the only invoice underpaid; MoonPay's word without the chain marks
// nothing. MoonPay Enterprise and the chain are doubles; no network.

interface PgResult { fields: { name: string; dataTypeID: number }[]; rows: unknown[][] }
interface Pg {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[], options?: Record<string, unknown>): Promise<{ rows: T[] } & Partial<PgResult>>;
  transaction<T>(fn: (tx: Pg) => Promise<T>): Promise<T>;
}
const PGLITE = "@electric-sql/pglite";
const mod = (await import(PGLITE).catch(() => null)) as { PGlite: new () => Pg } | null;
const it = mod ? test : test.skip;
const pg = mod ? new mod.PGlite() : (null as unknown as Pg);
const MIGRATIONS = new URL("../db/migrations/", import.meta.url);
const TEXT_OIDS = [16, 20, 21, 23, 25, 114, 700, 701, 1005, 1009, 1043, 1082, 1114, 1184, 1700, 3802];
const parsers = Object.fromEntries(TEXT_OIDS.map((oid) => [oid, (x: string) => x]));
async function run(q: { query: string; params: (string | null)[] }, tx: Pg = pg) {
  const r = (await tx.query<unknown[]>(q.query, q.params, { rowMode: "array", parsers })) as PgResult;
  return { fields: r.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })), rows: r.rows.map((row) => row.map((v) => (v === null ? null : String(v)))) };
}

const keyFrom = (seed: string) => nacl.sign.keyPair.fromSeed(Uint8Array.from(createHash("sha256").update(seed).digest()));
const KEY = keyFrom("owed test signer: bank-rail-db.test.ts");
const WALLET = bs58.encode(KEY.publicKey);
const OTHER = bs58.encode(keyFrom("owed test signer: bank-rail-db.test.ts, someone else").publicKey);
const signHex = (text: string, key = KEY) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), key.secretKey)).toString("hex");
const key32 = (label: string) => bs58.encode(createHash("sha256").update(label).digest());
const MOONPAY_WALLET = key32("moonpay enterprise payout wallet");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ONRAMP = "d3c2b1a4-e5f6-48a9-8123-fedcba654321";
const CUSTOMER = "123e4567-e89b-12d3-a456-426614174000";
const SECRET = "whsec_testsecret0123456789";
const CONFIG: EnterpriseConfig = { apiKey: "ent_test_0123456789abcdef", webhookSecret: SECRET, base: "https://api.sandbox.iron.xyz", sandbox: true };
let counter = 0;
const freshSig = () => bs58.encode(Buffer.concat([createHash("sha256").update(`bank sig a ${counter}`).digest(), createHash("sha256").update(`bank sig b ${counter++}`).digest()]));
const freshUuid = () => {
  const h = createHash("sha256").update(`bank uuid ${counter++}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith(NEON)) throw new TypeError(`no network in this test: ${url}`);
    const body = JSON.parse(String(init!.body));
    try {
      if (body.queries) {
        const results = await pg.transaction(async (tx) => {
          const out = [];
          for (const q of body.queries) out.push(await run(q, tx));
          return out;
        });
        return Response.json({ results });
      }
      return Response.json(await run(body));
    } catch (e) {
      const err = e as { message: string; code?: string; constraint?: string };
      return Response.json({ message: err.message, code: err.code, constraint: err.constraint }, { status: 400 });
    }
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  process.env.OWED_BASE_URL = "https://www.getowed.xyz";
  delete process.env.HELIUS_API_KEY;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

const BANK_ENV = { OWED_MOONPAY_ENTERPRISE: "1", OWED_BANK_RAIL: "1", MOONPAY_ENTERPRISE_API_KEY: CONFIG.apiKey, MOONPAY_ENTERPRISE_WEBHOOK_SECRET: SECRET, MOONPAY_ENTERPRISE_ENV: "sandbox" };
function setEnv(on: boolean) {
  for (const k of Object.keys(BANK_ENV)) delete process.env[k];
  if (on) Object.assign(process.env, BANK_ENV);
}
beforeEach(async () => {
  if (!mod) return;
  await pg.exec(`delete from bank_transfers; delete from virtual_accounts; delete from requests; delete from signature_nonces; delete from rate_events;`);
  setEnv(false);
});

function onramp(over: Record<string, unknown> = {}): Autoramp {
  return parseAutoramp({
    id: ONRAMP, customer_id: CUSTOMER, status: "Approved", kind: "Onramp",
    source_currencies: [{ type: "Fiat", code: "EUR" }], destination_currency: { type: "Crypto", token: "USDC", blockchain: "Solana" },
    recipient: { type: "Wallet", blockchain: "Solana", address: WALLET },
    deposit_rails: [{ type: "SEPA", iban: "DE89370400440532013000", bic: "COBADEFFXXX", beneficiary_name: "Jane Doe", name: "Iron Bank" }],
    ...over,
  })!;
}

async function register(autoramp = onramp()) {
  const now = Date.now();
  const deps = { config: CONFIG, fetchAutoramp: async () => autoramp, now: () => now };
  const first = await registerVirtualAccount({ wallet: WALLET, autorampId: ONRAMP }, deps);
  assert.equal(first.step, "sign");
  const message = first.step === "sign" ? first.messageToSign : "";
  return registerVirtualAccount({ wallet: WALLET, autorampId: ONRAMP, signedMessage: message, signature: signHex(message) }, deps);
}

/** An open USDC request to WALLET, optionally a EUR local-currency ask. */
async function openRequest({ amount = 108_000_000n, eur = "100" as string | null, recipient = WALLET, kind = "single" } = {}) {
  const reference = key32(`bank reference ${counter++}`);
  const id = requestIdFor({ recipient, token: "USDC", amountAtomic: amount, reference });
  await pg.query(
    `insert into requests (id, kind, recipient, token, mint, decimals, amount_atomic, reference, source, status, for_text,
                           fiat_currency, fiat_amount, fiat_rate, fiat_rate_source, fiat_quoted_at, created_at)
     values ($1, $2, $3, 'USDC', $4, 6, $5, $6, 'plugin', 'open', 'design work', $7, $8, $9, $10, $11, now() - interval '1 day')`,
    [id, kind, recipient, USDC, amount.toString(), reference, eur ? "EUR" : null, eur, eur ? "0.925925925926" : null, eur ? "test" : null, eur ? new Date().toISOString() : null],
  );
  return id;
}

function txOf(over: Record<string, unknown> = {}): AutorampTransaction {
  return parseAutorampTransaction({
    id: freshUuid(), customer_id: CUSTOMER, autoramp_id: ONRAMP, status: "Completed",
    source_amount: { amount: "100", currency: { type: "Fiat", code: "EUR" } },
    destination_amount: { amount: "107.4", currency: { type: "Crypto", token: "USDC", blockchain: "Solana" } },
    recipient: { type: "Wallet", blockchain: "Solana", address: WALLET },
    payout_crypto_transaction: { transaction_hash: freshSig() }, created_at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  })!;
}

/** MoonPay's USDC payout as mainnet returns it: MoonPay's wallet -> the recipient's USDC account. */
function payout(signature: string, { to = WALLET, credit = 107_400_000n } = {}): ParsedTransaction {
  const keys = [MOONPAY_WALLET, key32(`ata ${MOONPAY_WALLET}`), key32(`ata ${to}`), USDC];
  return {
    slot: 300_000_000, blockTime: Math.floor(Date.now() / 1000) - 30,
    meta: {
      err: null, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1), innerInstructions: [],
      preTokenBalances: [{ accountIndex: 2, mint: USDC, owner: to, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC, owner: to, uiTokenAmount: { amount: String(credit) } }],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })),
        instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { source: keys[1], mint: USDC, destination: keys[2], authority: MOONPAY_WALLET, tokenAmount: { amount: String(credit) } } } }],
      },
    },
  };
}

function bankDeps(tx: AutorampTransaction, chain: (sig: string) => ParsedTransaction | null): BankDeps & { reads: number } {
  const d = {
    reads: 0,
    config: CONFIG as EnterpriseConfig | null,
    fetchTransactions: async (ids: readonly string[]) => (ids.includes(tx.id) ? [tx] : []),
    getTransaction: async (sig: string) => { d.reads++; return chain(sig); },
    sleep: async () => undefined,
  };
  return d;
}
const event = (tx: AutorampTransaction) => ({ type: "transaction_status" as const, customerId: CUSTOMER, transactionId: tx.id });
const stateOf = async (id: string) => (await pg.query<{ state: string; request_id: string | null }>(`select state, request_id from bank_transfers where provider_tx_id = $1`, [id])).rows[0];

// ---------------------------------------------------------------- registering and the offer

it("registerVirtualAccount stores only the payer-facing details, under the recipient's signature", async () => {
  const out = await register();
  assert.equal(out.step, "stored");
  const va = out.step === "stored" ? out.account : null!;
  assert.equal(va.currency, "EUR");
  assert.deepEqual(va.rails, ["SEPA"]);
  assert.equal(va.detailsHash, detailsHash(va.details));
  assert.ok(va.signedMessage.startsWith(`${bankAccountPrefix(ONRAMP, va.detailsHash, WALLET)} at `));
  // Another wallet can't register it, and a stale or foreign signature is refused.
  await assert.rejects(registerVirtualAccount({ wallet: OTHER, autorampId: ONRAMP }, { config: CONFIG, fetchAutoramp: async () => onramp(), now: Date.now }), /different wallet/);
  const msg = `${bankAccountPrefix(ONRAMP, va.detailsHash, WALLET)} at ${isoSeconds(Date.now() - 10 * 60_000)}`;
  await assert.rejects(registerVirtualAccount({ wallet: WALLET, autorampId: ONRAMP, signedMessage: msg, signature: signHex(msg) }, { config: CONFIG, fetchAutoramp: async () => onramp(), now: Date.now }), /more than 5 minutes old/);
});

it("bankOffer: nothing with the flag off; the exact EUR amount and signed details with it on; nothing for tampered details", async () => {
  await register();
  const req = { recipient: WALLET, token: "USDC", amount: "108", status: "open", fiat: { currency: "EUR", amount: "100" } };
  assert.equal(await bankOffer(req), null, "flag off");
  setEnv(true);
  const offer = await bankOffer(req);
  assert.deepEqual(offer, { currency: "EUR", amount: "100", sandbox: true, rails: [{ type: "SEPA", iban: "DE89370400440532013000", bic: "COBADEFFXXX", account_holder: "Jane Doe", bank_name: "Iron Bank" }] });
  assert.equal(await bankOffer({ ...req, status: "paid" }), null, "only open invoices");
  assert.equal(await bankOffer({ ...req, fiat: null }), null, "a USD (plain USDC) invoice needs a USD account");
  assert.equal(await bankOffer({ ...req, recipient: OTHER }), null, "only the recipient's own account");
  await pg.query(`update virtual_accounts set account_details = jsonb_set(account_details, '{rails,0,iban}', '"GB33BUKB20201555555555"')`);
  assert.equal(await bankOffer(req), null, "details changed after the recipient signed them are never shown");
});

// ---------------------------------------------------------------- attribution

it("a unique amount is paid only after the chain confirms MoonPay's payout (rail bank_transfer, USDC delivered recorded)", async () => {
  await register();
  const invoice = await openRequest({ eur: "100" });
  const other = await openRequest({ eur: "250", amount: 270_000_000n });
  const tx = txOf();
  const out = await processEnterpriseEvent(event(tx), bankDeps(tx, (sig) => payout(sig)));
  assert.deepEqual(out, { kind: "settled", state: "verified", requestId: invoice });
  const row = await getRequest(invoice);
  assert.equal(row?.status, "paid");
  assert.equal(row?.paidRail, "bank_transfer");
  assert.equal(row?.paidAmountAtomic, 107_400_000n, "what MoonPay delivered after its conversion");
  assert.equal(row?.paidPayer, MOONPAY_WALLET);
  assert.equal(row?.paidSignature, tx.payoutHash);
  assert.equal((await getRequest(other))?.status, "open");
  assert.deepEqual(await stateOf(tx.id), { state: "verified", request_id: invoice });
  // The public request shape carries the new rail, and both mirrors parse it.
  const pub = toPublic(row!, "https://www.getowed.xyz");
  assert.equal(pub.paid?.rail, "bank_transfer");
  assert.ok(GetRequestResponse.safeParse(JSON.parse(JSON.stringify(pub))).success);
  assert.deepEqual(check(shapes.getRequestRes, JSON.parse(JSON.stringify(pub))).errors, []);
  // A repeat delivery of the same event changes nothing.
  assert.deepEqual(await processEnterpriseEvent(event(tx), bankDeps(tx, (sig) => payout(sig))), { kind: "recorded", state: "verified" });
});

it("two open invoices sharing the amount: nothing is marked (the recipient uses match_payments)", async () => {
  await register();
  const a = await openRequest({ eur: "100" });
  const b = await openRequest({ eur: "100", amount: 108_000_001n });
  const tx = txOf();
  assert.deepEqual(await processEnterpriseEvent(event(tx), bankDeps(tx, (sig) => payout(sig))), { kind: "recorded", state: "ambiguous" });
  assert.equal((await getRequest(a))?.status, "open");
  assert.equal((await getRequest(b))?.status, "open");
});

it("less than the only open invoice in that currency: underpaid (ask_for_rest can ask for the rest)", async () => {
  await register();
  const invoice = await openRequest({ eur: "100" });
  const tx = txOf({ source_amount: { amount: "90", currency: { type: "Fiat", code: "EUR" } }, destination_amount: { amount: "96.6", currency: { type: "Crypto", token: "USDC", blockchain: "Solana" } } });
  assert.deepEqual(await processEnterpriseEvent(event(tx), bankDeps(tx, (sig) => payout(sig, { credit: 96_600_000n }))), { kind: "settled", state: "underpaid", requestId: invoice });
  const row = await getRequest(invoice);
  assert.equal(row?.status, "underpaid");
  assert.equal(row?.paidRail, "bank_transfer");
  assert.equal(row?.paidAmountAtomic, 96_600_000n);
});

it("MoonPay's word without the chain marks nothing; the next event, once the chain shows it, settles", async () => {
  await register();
  const invoice = await openRequest({ eur: "100" });
  const tx = txOf();
  const waiting = bankDeps(tx, () => null);
  assert.deepEqual(await processEnterpriseEvent(event(tx), waiting), { kind: "recorded", state: "sent" });
  assert.equal(waiting.reads, 3, "a few reads, then the next event");
  assert.equal((await getRequest(invoice))?.status, "open");
  assert.equal((await stateOf(tx.id)).state, "sent");
  assert.deepEqual(await processEnterpriseEvent(event(tx), bankDeps(tx, (sig) => payout(sig))), { kind: "settled", state: "verified", requestId: invoice });
});

it("a payout that doesn't credit the recipient, a transaction for another wallet, or a failure marks nothing", async () => {
  await register();
  const invoice = await openRequest({ eur: "100" });
  const wrongChain = txOf();
  assert.deepEqual(await processEnterpriseEvent(event(wrongChain), bankDeps(wrongChain, (sig) => payout(sig, { to: OTHER }))), { kind: "recorded", state: "mismatch" });
  const theirs = txOf({ recipient: { type: "Wallet", blockchain: "Solana", address: OTHER } });
  assert.deepEqual(await processEnterpriseEvent(event(theirs), bankDeps(theirs, (sig) => payout(sig))), { kind: "recorded", state: "mismatch" });
  const failed = txOf({ status: "RejectedAml", payout_crypto_transaction: null });
  assert.deepEqual(await processEnterpriseEvent(event(failed), bankDeps(failed, () => null)), { kind: "recorded", state: "failed" });
  const pending = txOf({ status: "ConversionInProgress", payout_crypto_transaction: null });
  assert.deepEqual(await processEnterpriseEvent(event(pending), bankDeps(pending, () => null)), { kind: "recorded", state: "pending" });
  assert.equal((await getRequest(invoice))?.status, "open");
  // Not a registered virtual account, or the rail off: ignored.
  const elsewhere = txOf({ autoramp_id: freshUuid() });
  assert.equal((await processEnterpriseEvent(event(elsewhere), bankDeps(elsewhere, (sig) => payout(sig)))).kind, "ignored");
  assert.equal((await processEnterpriseEvent(event(elsewhere), { ...bankDeps(elsewhere, (sig) => payout(sig)), config: null })).kind, "ignored");
});

it("a USD virtual account settles a plain USDC invoice on its USD amount", async () => {
  await register(onramp({ source_currencies: [{ type: "Fiat", code: "USD" }], deposit_rails: [{ type: "ACH", routing_number: "021000021", account_number: "123456789", recipient_name: "Jane Doe", bank_name: "JPMorgan Chase Bank" }] }));
  const invoice = await openRequest({ eur: null, amount: 250_000_000n });
  const tx = txOf({ source_amount: { amount: "250.00", currency: { type: "Fiat", code: "USD" } } });
  assert.deepEqual(await processEnterpriseEvent(event(tx), bankDeps(tx, (sig) => payout(sig, { credit: 249_100_000n }))), { kind: "settled", state: "verified", requestId: invoice });
});

// ---------------------------------------------------------------- the webhook route

function signed(body: unknown, secret = SECRET): Request {
  const text = JSON.stringify(body);
  const t = String(Math.floor(Date.now() / 1000));
  return new Request("https://www.getowed.xyz/api/hooks/moonpay-enterprise", {
    method: "POST", body: text,
    headers: { "webhook-id": freshUuid(), "webhook-timestamp": t, "webhook-signature": `v1=${createHmac("sha256", secret).update(`${t}${text}`).digest("hex")}` },
  });
}

it("the Enterprise hook: 404 while off; with it on, verifies webhook-signature and acknowledges only transaction events", async () => {
  const ping = { type: "ping", timestamp: "x", data: { customer_id: CUSTOMER, message: { Ping: { id: freshUuid() } } } };
  assert.equal((await enterpriseHook(signed(ping))).status, 404);
  setEnv(true);
  assert.equal((await enterpriseHook(signed(ping, "whsec_wrongsecret0000000"))).status, 401);
  const unsigned = new Request("https://www.getowed.xyz/api/hooks/moonpay-enterprise", { method: "POST", body: JSON.stringify(ping) });
  assert.equal((await enterpriseHook(unsigned)).status, 401);
  assert.deepEqual(await (await enterpriseHook(signed(ping))).json(), { received: false });
  const tx = { type: "transaction", timestamp: "x", data: { customer_id: CUSTOMER, message: { Event: { id: freshUuid(), kind: "Transaction" } } } };
  // Accepted; the deferred read of MoonPay fails here (no network) and marks nothing.
  assert.deepEqual(await (await enterpriseHook(signed(tx))).json(), { received: true });
  assert.equal((await pg.query(`select 1 from bank_transfers`)).rows.length, 0);
});
