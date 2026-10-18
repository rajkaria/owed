import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { POST as createRoute } from "@/app/api/v1/cash-out/route";
import { GET as statusRoute, POST as statusPostRoute } from "@/app/api/v1/cash-out/[id]/route";
import { POST as accountsRoute } from "@/app/api/v1/cash-out/accounts/route";
import { POST as virtualAccountsRoute } from "@/app/api/v1/virtual-accounts/route";
import { POST as moonpayHook } from "@/app/api/hooks/moonpay/route";
import { POST as enterpriseHook } from "@/app/api/hooks/moonpay-enterprise/route";
import { GET as returnPage } from "@/app/cash-out/[id]/route";
import { CashOutAccountResponse, CashOutResponse } from "@/lib/contract";
import { requestIdFor } from "@/lib/ids";
import { cashOutAccountPrefix, registerCashOutAccount } from "@/lib/moonpay/accounts";
import { cashOutStatus, createCashOut, ingestSellEvent, NOT_ON, type CashOutDeps } from "@/lib/moonpay/cash-out";
import { SELL_WIDGET_SANDBOX, type MoonpaySellConfig } from "@/lib/moonpay/config";
import { parseAutoramp, type Autoramp, type EnterpriseConfig } from "@/lib/moonpay/enterprise";
import { parseSellTx, type SellTx } from "@/lib/moonpay/sell";
import { getRequest } from "@/lib/requests";
import { isoSeconds } from "@/lib/verify-signature";
import { check, shapes } from "../../contract/shapes.mjs";

const SHAPES = shapes as unknown as Record<string, Parameters<typeof check>[0]>;

// F4 cash out on real Postgres (every migration on PGlite, answering lib/db.ts's Neon-over-HTTP calls): migration 0024,
// creating a cash-out from an amount or from paid requests (only USDC requests paid to this wallet, after refunds),
// reading its status against a MoonPay double (every mismatch refused: currency, amount, refund wallet, status, another
// wallet's cash-out), the signed sell webhook recording the deposit address (never a caller), the Enterprise path's
// wallet-signed liquidation address, and every route refusing while its flag is off. MoonPay is a double; no network.

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
const KEY = keyFrom("owed test signer: cash-out-db.test.ts");
const WALLET = bs58.encode(KEY.publicKey);
const OTHER = bs58.encode(keyFrom("owed test signer: cash-out-db.test.ts, someone else").publicKey);
const PAYER = bs58.encode(keyFrom("owed test signer: cash-out-db.test.ts, a payer").publicKey);
const signHex = (text: string, key = KEY) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), key.secretKey)).toString("hex");
const key32 = (label: string) => bs58.encode(createHash("sha256").update(label).digest());
const DEPOSIT = key32("moonpay deposit wallet");
const LIQUIDATION = key32("moonpay liquidation address");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE = "https://www.getowed.xyz";
const OFFRAMP = "9a7b6c5d-e3f1-4a2b-8c7d-6e5f4a3b2c1d";
const CUSTOMER = "123e4567-e89b-12d3-a456-426614174000";
let counter = 0;
const freshSig = () => bs58.encode(Buffer.concat([createHash("sha256").update(`co sig a ${counter}`).digest(), createHash("sha256").update(`co sig b ${counter++}`).digest()]));

// ---- MoonPay doubles (REST through global fetch for the routes; injected deps for the library) ----
const salesByExt = new Map<string, unknown[]>();
let moonpayDown = false;
const NEON = "https://api.us-east-1.aws.neon.tech/sql";
before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.moonpay.com/v3/sell_transactions/ext/")) {
      if (moonpayDown) throw new TypeError("fetch failed");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Api-Key sk_test_cashout", "the secret key goes server to server only");
      const ext = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
      const list = salesByExt.get(ext);
      return list ? Response.json(list) : Response.json({ moonPayErrorCode: "x", message: "Not found", type: "NotFoundError" }, { status: 404 });
    }
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
  process.env.OWED_BASE_URL = BASE;
  delete process.env.HELIUS_API_KEY;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

const SELL_ENV = { OWED_MOONPAY_SELL: "1", MOONPAY_PUBLISHABLE_KEY: "pk_test_cashout", MOONPAY_SECRET_KEY: "sk_test_cashout", MOONPAY_WEBHOOK_KEY: "wk_test_cashout" };
const ENTERPRISE_ENV = { OWED_MOONPAY_ENTERPRISE: "1", MOONPAY_ENTERPRISE_API_KEY: "ent_test_0123456789abcdef", MOONPAY_ENTERPRISE_WEBHOOK_SECRET: "whsec_testsecret0123456789", MOONPAY_ENTERPRISE_ENV: "sandbox" };
const FLAG_KEYS = [...Object.keys(SELL_ENV), ...Object.keys(ENTERPRISE_ENV), "OWED_BANK_RAIL", "NEXT_PUBLIC_OWED_MOONPAY"];
function setEnv(env: Record<string, string>) {
  for (const k of FLAG_KEYS) delete process.env[k];
  Object.assign(process.env, env);
}

beforeEach(async () => {
  if (!mod) return;
  await pg.exec(`delete from cash_outs; delete from cash_out_accounts; delete from refunds; delete from requests; delete from signature_nonces; delete from rate_events;`);
  salesByExt.clear();
  moonpayDown = false;
  setEnv({});
});

const SELL: MoonpaySellConfig = { publishableKey: "pk_test_cashout", secretKey: "sk_test_cashout", webhookKey: "wk_test_cashout", sandbox: true, widgetBase: SELL_WIDGET_SANDBOX };
const ENTERPRISE: EnterpriseConfig = { apiKey: "ent_test_0123456789abcdef", webhookSecret: "whsec_testsecret0123456789", base: "https://api.sandbox.iron.xyz", sandbox: true };

function deps(over: Partial<CashOutDeps> & { sales?: SellTx[] } = {}): CashOutDeps & { calls: number } {
  const d = {
    calls: 0,
    sell: SELL as MoonpaySellConfig | null,
    enterprise: null as EnterpriseConfig | null,
    fetchSales: async () => { d.calls++; return over.sales ?? []; },
    fetchAutoramp: async () => null as Autoramp | null,
    ...over,
  };
  return d;
}

/** A USDC request already paid to `recipient` (as the settle path writes it). */
async function paidRequest({ recipient = WALLET, amount = 10_000_000n, paid = amount, status = "paid", token = "USDC" }: { recipient?: string; amount?: bigint; paid?: bigint; status?: string; token?: "USDC" | "SOL" } = {}) {
  const reference = key32(`cash-out reference ${counter++}`);
  const id = requestIdFor({ recipient, token, amountAtomic: amount, reference });
  const isPaid = status === "paid" || status === "underpaid";
  await pg.query(
    `insert into requests (id, recipient, token, mint, decimals, amount_atomic, reference, source, status, paid_signature, paid_payer, paid_amount_atomic, paid_at, paid_rail, for_text)
     values ($1, $2, $3, $4, $5, $6, $7, 'plugin', $8, $9, $10, $11, case when $12 then now() - interval '1 hour' end, $13, 'rent')`,
    [id, recipient, token, token === "USDC" ? USDC : null, token === "USDC" ? 6 : 9, amount.toString(), reference, status,
      isPaid ? freshSig() : null, isPaid ? PAYER : null, isPaid ? paid.toString() : null, isPaid, isPaid ? "solana_pay" : null],
  );
  return id;
}

function sale(id: string, over: Record<string, unknown> = {}, source: "api" | "webhook" = "api"): SellTx {
  return parseSellTx({
    id: `mp-sell-${id}`, status: "waitingForDeposit", externalTransactionId: id, refundWalletAddress: WALLET, baseCurrency: { code: "usdc_sol" },
    baseCurrencyAmount: 10, depositHash: null, failureReason: null, updatedAt: new Date().toISOString(),
    depositWallet: { walletAddress: DEPOSIT, walletAddressTag: null }, ...over,
  }, source)!;
}

// ---------------------------------------------------------------- migrations

it("0023 + 0024: the rail check takes every old rail and bank_transfer, nothing else; Base rows never bank_transfer", async () => {
  for (const rail of ["solana_pay", "x402", "matched", "moonpay_card", "bank_transfer"]) {
    const id = await paidRequest();
    await pg.query(`update requests set paid_rail = $2 where id = $1`, [id, rail]);
  }
  const id = await paidRequest();
  await assert.rejects(pg.query(`update requests set paid_rail = 'wire' where id = $1`, [id]), /requests_paid_rail_check/);
  const cons = await pg.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'requests_paid_rail_check'`);
  for (const rail of ["solana_pay", "x402", "base_transfer", "matched", "moonpay_card", "bank_transfer"]) assert.match(cons.rows[0].def, new RegExp(`'${rail}'`));
  const base = await pg.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('requests_base_shape', 'requests_solana_rail')`);
  assert.ok(base.rows.some((r) => /base_transfer/.test(r.def)), "0011 keeps Base rows to base_transfer / x402");
  const rls = await pg.query<{ relname: string; relrowsecurity: boolean }>(`select relname, relrowsecurity from pg_class where relname in ('cash_outs', 'cash_out_accounts', 'virtual_accounts', 'bank_transfers')`);
  assert.equal(rls.rows.length, 4);
  for (const r of rls.rows) assert.equal(r.relrowsecurity, true, `${r.relname} has RLS on`);
  // Idempotent: both apply again cleanly.
  for (const f of ["0023_bank_rail.sql", "0024_cash_out.sql"]) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

it("0024: a deposit address can never be the wallet itself, and an Enterprise cash-out needs its account", async () => {
  await assert.rejects(pg.query(`insert into cash_outs (id, wallet, amount_atomic, mode, status, deposit_address) values ('Ab3dEfGh2jKm', $1, 1, 'sell_widget', 'created', $1)`, [WALLET]), /check/);
  await assert.rejects(pg.query(`insert into cash_outs (id, wallet, amount_atomic, mode, status) values ('Ab3dEfGh2jKm', $1, 1, 'enterprise', 'created')`, [WALLET]), /check/);
});

// ---------------------------------------------------------------- creating

it("createCashOut from an amount: whole cents, the sell widget path, status created", async () => {
  const { row } = await createCashOut({ wallet: WALLET, amount: "10" }, deps());
  assert.equal(row.amountAtomic, 10_000_000n);
  assert.equal(row.mode, "sell_widget");
  assert.equal(row.status, "created");
  assert.match(row.id, /^[1-9A-HJ-NP-Za-km-z]{12}$/);
  await assert.rejects(createCashOut({ wallet: WALLET, amount: "10.001" }, deps()), /whole cents/);
  await assert.rejects(createCashOut({ wallet: WALLET, amount: "0" }, deps()), /amount/);
  await assert.rejects(createCashOut({ wallet: WALLET, amount: "10", requestIds: ["Ab3dEfGh2jKm"] }, deps()), /not both/);
  await assert.rejects(createCashOut({ wallet: WALLET, amount: "10", fiatCurrency: "xyz" }, deps()), /isn't one MoonPay pays out in/);
  await assert.rejects(createCashOut({ wallet: WALLET, amount: "10" }, deps({ sell: null })), (e: Error) => e.message === NOT_ON);
});

it("createCashOut from request_ids: only USDC requests paid to this wallet, after refunds, rounded down to cents", async () => {
  const a = await paidRequest({ amount: 10_000_000n });
  const b = await paidRequest({ amount: 5_000_000n, paid: 4_123_456n, status: "underpaid" });
  const { row, requestsTotalAtomic } = await createCashOut({ wallet: WALLET, requestIds: [a, b], fiatCurrency: "EUR" }, deps());
  assert.equal(requestsTotalAtomic, 14_123_456n);
  assert.equal(row.amountAtomic, 14_120_000n, "MoonPay sells whole cents: the 0.003456 stays in the wallet");
  assert.equal(row.fiatCurrency, "eur");
  assert.deepEqual(row.requestIds, [a, b]);

  const theirs = await paidRequest({ recipient: OTHER });
  await assert.rejects(createCashOut({ wallet: WALLET, requestIds: [theirs] }, deps()), /pays a different wallet/);
  const open = await paidRequest({ status: "open" });
  await assert.rejects(createCashOut({ wallet: WALLET, requestIds: [open] }, deps()), /isn't paid \(it is open\)/);
  const sol = await paidRequest({ token: "SOL", amount: 1_000_000_000n });
  await assert.rejects(createCashOut({ wallet: WALLET, requestIds: [sol] }, deps()), /isn't a USDC request/);
  await assert.rejects(createCashOut({ wallet: WALLET, requestIds: ["Zz3dEfGh2jKm"] }, deps()), /isn't an Owed request/);
  await assert.rejects(createCashOut({ wallet: WALLET, requestIds: [a] }, deps()), /already in cash-out/, "a request is cashed out once");

  const c = await paidRequest({ amount: 3_000_000n });
  // A confirmed F8 refund of 1 USDC (migration 0021's columns).
  await pg.query(
    `insert into refunds (id, request_id, recipient, payer, token, amount_atomic, reference, signed_message, signature, status,
                          confirmed_signature, confirmed_instruction, confirmed_amount_atomic, confirmed_at, confirmed_slot)
     values ('Rf3dEfGh2jKm', $1, $2, $3, 'USDC', 1000000, $4, 'm', $5, 'confirmed', $6, 0, 1000000, now(), 1)`,
    [c, WALLET, PAYER, key32("refund ref"), "a".repeat(128), freshSig()],
  );
  const refunded = await createCashOut({ wallet: WALLET, requestIds: [c] }, deps());
  assert.equal(refunded.requestsTotalAtomic, 2_000_000n, "a refunded USDC isn't cashed out again");
});

// ---------------------------------------------------------------- status and the webhook

it("cashOutStatus: no sale yet -> no address; another wallet's cash-out reads as missing", async () => {
  const { row } = await createCashOut({ wallet: WALLET, amount: "10" }, deps());
  const none = await cashOutStatus(row.id, WALLET, deps());
  assert.equal(none.depositAddress, null);
  assert.match(none.problem!, /no sale for this cash-out yet/);
  await assert.rejects(cashOutStatus(row.id, OTHER, deps()), (e: Error & { code?: string }) => e.code === "not_found" && /no cash-out/.test(e.message));
  await assert.rejects(cashOutStatus("Zz3dEfGh2jKm", WALLET, deps()), (e: Error & { code?: string }) => e.code === "not_found");
});

it("the deposit address comes only from MoonPay's signed webhook for the matching sale, and is released only while MoonPay waits for it", async () => {
  const { row } = await createCashOut({ wallet: WALLET, amount: "10" }, deps());
  // MoonPay waits for the deposit, but its webhook hasn't arrived: nothing to send to yet.
  const early = await cashOutStatus(row.id, WALLET, deps({ sales: [sale(row.id)] }));
  assert.equal(early.depositAddress, null);
  assert.match(early.problem!, /hasn't sent Owed its deposit address yet/);
  assert.equal(early.row.status, "waiting_for_deposit");
  assert.equal(early.row.moonpayTransactionId, `mp-sell-${row.id}`);

  // The verified webhook names the deposit wallet.
  assert.equal((await ingestSellEvent(sale(row.id, {}, "webhook"))).outcome, "stored");
  const ready = await cashOutStatus(row.id, WALLET, deps({ sales: [sale(row.id)] }));
  assert.equal(ready.problem, null);
  assert.equal(ready.depositAddress, DEPOSIT);

  // Each mismatch in MoonPay's current answer withholds the address.
  for (const [over, why] of [
    [{ baseCurrency: { code: "usdc" } }, /not USDC on Solana/],
    [{ baseCurrencyAmount: 9.99 }, /different amount/],
    [{ refundWalletAddress: OTHER }, /refunds a different wallet/],
  ] as const) {
    const r = await cashOutStatus(row.id, WALLET, deps({ sales: [sale(row.id, over)] }));
    assert.equal(r.depositAddress, null);
    assert.match(r.problem!, why);
  }
  // MoonPay already got the deposit: no second transfer.
  const pending = await cashOutStatus(row.id, WALLET, deps({ sales: [sale(row.id, { status: "pending", depositHash: freshSig(), updatedAt: new Date(Date.now() + 1000).toISOString() })] }));
  assert.equal(pending.depositAddress, null);
  assert.equal(pending.row.status, "pending");
  assert.ok(pending.row.transferSignature, "MoonPay's depositHash is kept as the transfer signature");
  // MoonPay unreachable: never an address from memory.
  const down = await cashOutStatus(row.id, WALLET, deps({ fetchSales: async () => { throw new Error("down"); } }));
  assert.equal(down.depositAddress, null);
  assert.match(down.problem!, /couldn't be reached/);
});

it("ingestSellEvent: a webhook whose terms don't match is ignored, and a cash-out never touches a request", async () => {
  const paid = await paidRequest({ amount: 10_000_000n });
  const { row } = await createCashOut({ wallet: WALLET, requestIds: [paid] }, deps());
  for (const over of [{ refundWalletAddress: OTHER }, { baseCurrencyAmount: 11 }, { baseCurrency: { code: "sol" } }]) {
    assert.equal((await ingestSellEvent(sale(row.id, over, "webhook"))).outcome, "ignored");
  }
  const stored = await pg.query<{ deposit_address: string | null; moonpay_transaction_id: string | null }>(`select deposit_address, moonpay_transaction_id from cash_outs where id = $1`, [row.id]);
  assert.equal(stored.rows[0].deposit_address, null, "a mismatched sale never writes an address");
  assert.equal(stored.rows[0].moonpay_transaction_id, null);
  // A tag or a non-Solana address is not stored either.
  await ingestSellEvent(sale(row.id, { depositWallet: { walletAddress: DEPOSIT, walletAddressTag: "77" } }, "webhook"));
  assert.equal((await pg.query<{ d: string | null }>(`select deposit_address as d from cash_outs where id = $1`, [row.id])).rows[0].d, null);
  // A completed sale: recorded on the cash-out; the request stays exactly as it was.
  await ingestSellEvent(sale(row.id, { status: "completed", depositHash: freshSig() }, "webhook"));
  assert.equal((await pg.query<{ s: string }>(`select status as s from cash_outs where id = $1`, [row.id])).rows[0].s, "completed");
  const req = await getRequest(paid);
  assert.equal(req?.status, "paid");
  assert.equal(req?.paidRail, "solana_pay");
  // Not an Owed cash-out at all.
  assert.equal((await ingestSellEvent(sale("Zz3dEfGh2jKm", {}, "webhook"))).outcome, "ignored");
});

it("ingestSellEvent: out-of-order reports never move a cash-out back; a failed sale can be replaced by a new one", async () => {
  const { row } = await createCashOut({ wallet: WALLET, amount: "10" }, deps());
  const t = (s: number) => new Date(Date.parse("2026-10-18T10:00:00Z") + s * 1000).toISOString();
  await ingestSellEvent(sale(row.id, { status: "pending", updatedAt: t(20) }, "webhook"));
  assert.equal((await ingestSellEvent(sale(row.id, { status: "waitingForDeposit", updatedAt: t(10) }, "webhook"))).outcome, "stale");
  assert.equal((await pg.query<{ s: string }>(`select status as s from cash_outs where id = $1`, [row.id])).rows[0].s, "pending");
  assert.equal((await ingestSellEvent(sale(row.id, { id: "mp-sell-second", updatedAt: t(30) }, "webhook"))).outcome, "ignored", "another sale while one is live");
  await ingestSellEvent(sale(row.id, { status: "failed", failureReason: "Deposit timeout", updatedAt: t(40) }, "webhook"));
  assert.equal((await ingestSellEvent(sale(row.id, { id: "mp-sell-second", updatedAt: t(50) }, "webhook"))).outcome, "stored", "the user started over from the same link");
  const after = await pg.query<{ id: string; s: string; d: string }>(`select moonpay_transaction_id as id, status as s, deposit_address as d from cash_outs where id = $1`, [row.id]);
  assert.deepEqual(after.rows[0], { id: "mp-sell-second", s: "waiting_for_deposit", d: DEPOSIT });
});

// ---------------------------------------------------------------- routes

it("routes: everything refuses while MoonPay isn't configured", async () => {
  const create = await createRoute(new Request(`${BASE}/api/v1/cash-out`, { method: "POST", body: JSON.stringify({ wallet: WALLET, amount: "10" }) }));
  assert.equal(create.status, 503);
  assert.match(((await create.json()) as { error: { message: string } }).error.message, /isn't switched on yet/);
  const status = await statusRoute(new Request(`${BASE}/api/v1/cash-out/Ab3dEfGh2jKm?wallet=${WALLET}`), { params: Promise.resolve({ id: "Ab3dEfGh2jKm" }) } as Parameters<typeof statusRoute>[1]);
  assert.equal(status.status, 503);
  const accounts = await accountsRoute(new Request(`${BASE}/api/v1/cash-out/accounts`, { method: "POST", body: "{}" }));
  assert.equal(accounts.status, 404);
  const va = await virtualAccountsRoute(new Request(`${BASE}/api/v1/virtual-accounts`, { method: "POST", body: "{}" }));
  assert.equal(va.status, 404);
  const hook = await enterpriseHook(new Request(`${BASE}/api/hooks/moonpay-enterprise`, { method: "POST", body: "{}" }));
  assert.equal(hook.status, 404);
  const mp = await moonpayHook(new Request(`${BASE}/api/hooks/moonpay`, { method: "POST", body: "{}" }));
  assert.equal(mp.status, 503, "no webhook key: the MoonPay hook refuses, as before");
  assert.equal((await pg.query(`select 1 from cash_outs`)).rows.length, 0, "nothing was stored");
});

function signedHook(body: unknown, key = SELL_ENV.MOONPAY_WEBHOOK_KEY): Request {
  const text = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  return new Request(`${BASE}/api/hooks/moonpay`, {
    method: "POST", body: text,
    headers: { "Moonpay-Signature-V2": `t=${t},s=${createHmac("sha256", key).update(`${t}.${text}`).digest("hex")}` },
  });
}

it("routes: create -> sell widget URL; signed webhook -> deposit address; status releases it; the return page reads nothing", async () => {
  setEnv(SELL_ENV);
  const res = await createRoute(new Request(`${BASE}/api/v1/cash-out`, { method: "POST", body: JSON.stringify({ wallet: WALLET, amount: "10", fiat_currency: "usd" }) }));
  assert.equal(res.status, 201);
  const created = CashOutResponse.parse(await res.json());
  assert.deepEqual(check(SHAPES.cashOutRes, created).errors, []);
  assert.equal(created.status, "created");
  assert.equal(created.deposit_address, null);
  const widget = new URL(created.widget_url!);
  assert.equal(widget.origin, SELL_WIDGET_SANDBOX);
  assert.equal(widget.searchParams.get("externalTransactionId"), created.id);
  assert.equal(widget.searchParams.get("refundWalletAddress"), WALLET);
  assert.equal(widget.searchParams.get("baseCurrencyAmount"), "10");
  assert.equal(widget.searchParams.get("redirectURL"), `${BASE}/cash-out/${created.id}`);

  const data = { id: `mp-sell-${created.id}`, status: "waitingForDeposit", externalTransactionId: created.id, refundWalletAddress: WALLET, baseCurrency: { code: "usdc_sol" }, baseCurrencyAmount: 10, updatedAt: new Date().toISOString(), depositWallet: { walletAddress: DEPOSIT, walletAddressTag: null } };
  // A webhook signed with the wrong key changes nothing.
  const forged = await moonpayHook(signedHook({ type: "sell_transaction_updated", data: { ...data, depositWallet: { walletAddress: OTHER } } }, "not the key"));
  assert.equal(forged.status, 401);
  const hook = await moonpayHook(signedHook({ type: "sell_transaction_created", data }));
  assert.equal(hook.status, 200);
  assert.deepEqual(await hook.json(), { received: true });

  // MoonPay's REST answer (no deposit address in it) confirms the sale.
  const restData: Record<string, unknown> = { ...data };
  delete restData.depositWallet;
  salesByExt.set(created.id, [restData]);
  const got = await statusRoute(new Request(`${BASE}/api/v1/cash-out/${created.id}?wallet=${WALLET}`), { params: Promise.resolve({ id: created.id }) } as Parameters<typeof statusRoute>[1]);
  assert.equal(got.status, 200);
  const status = CashOutResponse.parse(await got.json());
  assert.deepEqual(check(SHAPES.cashOutRes, status).errors, []);
  assert.equal(status.status, "waiting_for_deposit");
  assert.equal(status.deposit_address, DEPOSIT);
  assert.equal(status.moonpay_transaction_id, `mp-sell-${created.id}`);
  // POST with the wallet in the body reads the same; another wallet gets a 404.
  const posted = await statusPostRoute(new Request(`${BASE}/api/v1/cash-out/${created.id}`, { method: "POST", body: JSON.stringify({ wallet: WALLET }) }), { params: Promise.resolve({ id: created.id }) } as Parameters<typeof statusPostRoute>[1]);
  assert.equal(CashOutResponse.parse(await posted.json()).deposit_address, DEPOSIT);
  const theirs = await statusRoute(new Request(`${BASE}/api/v1/cash-out/${created.id}?wallet=${OTHER}`), { params: Promise.resolve({ id: created.id }) } as Parameters<typeof statusRoute>[1]);
  assert.equal(theirs.status, 404);

  // The page MoonPay returns the user to ignores the deposit details MoonPay appends.
  const page = await returnPage(new Request(`${BASE}/cash-out/${created.id}?transactionId=x&depositWalletAddress=${OTHER}`), { params: Promise.resolve({ id: created.id }) } as Parameters<typeof returnPage>[1]);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes(created.id) && !html.includes(OTHER), "the appended address is never echoed");

  // Card off: a Buy event on the same hook is acknowledged and dropped.
  const buy = await moonpayHook(signedHook({ type: "transaction_updated", data: { id: "x", status: "completed", walletAddress: WALLET, externalTransactionId: "Ab3dEfGh2jKm" } }));
  assert.deepEqual(await buy.json(), { received: false });
});

// ---------------------------------------------------------------- the Enterprise path

function offramp(address = LIQUIDATION): Autoramp {
  return parseAutoramp({
    id: OFFRAMP, customer_id: CUSTOMER, status: "Approved", kind: "Offramp",
    source_currencies: [{ type: "Crypto", token: "USDC", blockchain: "Solana" }], destination_currency: { type: "Fiat", code: "EUR" },
    recipient: { type: "BankAccount", account_identifier: { type: "SEPA", iban: "DE89370400440532013000" } },
    deposit_rails: [{ type: "Crypto", chain: "Solana", address }],
  })!;
}

it("Enterprise: register the liquidation address with the wallet's signature, then every status re-checks it against MoonPay", async () => {
  const now = Date.now();
  const reg = { config: ENTERPRISE, fetchAutoramp: async () => offramp(), now: () => now };
  const first = await registerCashOutAccount({ wallet: WALLET, autorampId: OFFRAMP }, reg);
  assert.equal(first.step, "sign");
  const message = first.step === "sign" ? first.messageToSign : "";
  assert.equal(message, `${cashOutAccountPrefix(OFFRAMP, LIQUIDATION, WALLET)} at ${isoSeconds(now)}`);
  await assert.rejects(registerCashOutAccount({ wallet: WALLET, autorampId: OFFRAMP, signedMessage: message, signature: signHex(message, keyFrom("someone else")) }, reg), /doesn't match/);
  const stored = await registerCashOutAccount({ wallet: WALLET, autorampId: OFFRAMP, signedMessage: message, signature: signHex(message) }, reg);
  assert.equal(stored.step, "stored");

  const d = deps({ sell: null, enterprise: ENTERPRISE, fetchAutoramp: async () => offramp() });
  const { row } = await createCashOut({ wallet: WALLET, amount: "25.5" }, d);
  assert.equal(row.mode, "enterprise");
  const ok = await cashOutStatus(row.id, WALLET, d);
  assert.equal(ok.problem, null);
  assert.equal(ok.depositAddress, LIQUIDATION);
  assert.equal(ok.account?.signedMessage, message, "the plugin gets the signed record to check itself");

  // MoonPay now names another address: nothing is released.
  const moved = await cashOutStatus(row.id, WALLET, deps({ sell: null, enterprise: ENTERPRISE, fetchAutoramp: async () => offramp(OTHER) }));
  assert.equal(moved.depositAddress, null);
  assert.match(moved.problem!, /isn't the one this wallet signed for/);
  // The stored record edited behind the wallet's back: nothing is released.
  await pg.query(`update cash_out_accounts set liquidation_address = $1`, [OTHER]);
  const edited = await cashOutStatus(row.id, WALLET, deps({ sell: null, enterprise: ENTERPRISE, fetchAutoramp: async () => offramp(OTHER) }));
  assert.equal(edited.depositAddress, null);
  assert.match(edited.problem!, /doesn't match the message its wallet signed/);
});

it("routes: the accounts route answers the message to sign with Enterprise on (MoonPay double through deps of the route)", async () => {
  setEnv(ENTERPRISE_ENV);
  // The route calls the real fetchAutoramp: MoonPay Enterprise is unreachable here, so it answers 503, never a guess.
  const res = await accountsRoute(new Request(`${BASE}/api/v1/cash-out/accounts`, { method: "POST", body: JSON.stringify({ wallet: WALLET, autoramp_id: OFFRAMP }) }));
  assert.equal(res.status, 503);
  assert.match(((await res.json()) as { error: { message: string } }).error.message, /couldn't be reached/);
  assert.equal(CashOutAccountResponse.safeParse({ step: "sign", message_to_sign: "m", sign_by: "2026-10-18T10:05:00Z", liquidation_address: LIQUIDATION, currency: "EUR", payout_rail: "SEPA" }).success, true);
});
