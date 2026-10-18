import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";
import { POST as createLedgerRoute } from "@/app/api/v1/ledgers/route";
import { GET as getLedgerRoute } from "@/app/api/v1/ledgers/[id]/route";
import { POST as addExpenseRoute } from "@/app/api/v1/ledgers/[id]/expenses/route";
import { POST as settleRoute } from "@/app/api/v1/ledgers/[id]/settle/route";
import { POST as inboxRoute } from "@/app/api/v1/inbox/route";
import { AddExpenseResponse, GroupLedgerResponse, InboxResponse, SettleUpResponse } from "@/lib/contract";
import { sql } from "@/lib/db";
import { FIAT_CURRENCIES, fromMinor, usdcAtomicFor } from "@/lib/fiat";
import { resetFxCache } from "@/lib/fx";
import { LEDGER_CAUTION } from "@/lib/ledgers";
import {
  decimalToUnits, expenseDigest, expensePrefix, ledgerText, settlePrefix, unitsToDecimal, WEIGHT_DECIMALS, type CanonicalExpense,
} from "@/lib/ledgers-math";

// F6 on real Postgres: migration 0020, the four ledger routes, and the acceptance rows end to end. 4 people, 5 expenses
// paid by 3 of them: settle-up creates at most 3 requests (one ordinary Owed request each, payable to the creditor,
// addressed to the debtor so it lands in their what_do_i_owe inbox), and paying them on chain zeroes every balance.
// Writes are signed by a wallet named in the ledger (the owner's or a member's), over exactly what is stored. PGlite
// answers lib/db.ts's Neon-over-HTTP calls; Solana answers from the transactions a test puts on `chain`; the two rate
// sources answer from web/test/fixtures/fx (real captures). Any other network call fails. Skips without PGlite.

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

// ---------------------------------------------------------------- wallets

/** A deterministic ed25519 wallet that signs like PayBox request_wallet_sign {op:"solanaMessage"} (UTF-8 bytes, hex out). */
function wallet(label: string) {
  const seed = createHash("sha256").update(`owed ledgers-db test: ${label}`, "utf8").digest();
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12));
  return { address, sign: (message: string) => sign(null, Buffer.from(message, "utf8"), key).toString("hex") };
}
const RAJ = wallet("raj, the owner");
const PRIYA = wallet("priya");
const SAM = wallet("sam");
const MALLORY = wallet("mallory, not in any ledger");
const TEAM_ATA = "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x"; // a USDC token account: off curve, never a wallet
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const key = (label: string) => bs58.encode(createHash("sha256").update(label, "utf8").digest());
// Every signed message must differ (a message works once): each takes the next earlier whole second.
const startSecond = Math.floor(Date.now() / 1000);
let signedSeconds = 0;
const isoNow = () => new Date((startSecond - ++signedSeconds) * 1000).toISOString().replace(".000Z", "Z");

// ---------------------------------------------------------------- network doubles

/** Transactions on "chain": references → parsed (jsonParsed) transaction. */
const chain: Array<{ refs: string[]; tx: Record<string, unknown> }> = [];
let chainDown = false;
const fx = (name: string) => readFileSync(new URL(`fixtures/fx/${name}`, import.meta.url), "utf8");
let coinbase = fx("coinbase-usd.json");
const erApi = fx("er-api-usd.json").replace(/"time_last_update_unix":\d+/, `"time_last_update_unix":${Math.floor(Date.now() / 1000) - 3600}`);

const NEON = "https://api.us-east-1.aws.neon.tech/sql";
before(async () => {
  if (!mod) return;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(NEON)) {
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
    }
    if (url === "https://api.coinbase.com/v2/exchange-rates?currency=USD") return new Response(coinbase);
    if (url === "https://open.er-api.com/v6/latest/USD") return new Response(erApi);
    if (/^https:\/\/(solana-rpc\.publicnode\.com|api\.mainnet-beta\.solana\.com)\/?$/.test(url)) {
      if (chainDown) throw new TypeError("fetch failed");
      const body = JSON.parse(String(init!.body));
      const answer = (m: { id: number; method: string; params: unknown[] }) => {
        if (m.method === "getSignaturesForAddress") {
          const list = chain.filter((t) => t.refs.includes(m.params[0] as string));
          return { jsonrpc: "2.0", id: m.id, result: list.map((t) => ({ signature: (t.tx.transaction as { signatures: string[] }).signatures[0], err: null })) };
        }
        if (m.method === "getTransaction") {
          const t = chain.find((c) => (c.tx.transaction as { signatures: string[] }).signatures[0] === m.params[0]);
          return { jsonrpc: "2.0", id: m.id, result: t?.tx ?? null };
        }
        throw new TypeError(`no ${m.method} in this test`);
      };
      return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    }
    throw new TypeError(`no network in this test: ${url}`);
  }) as typeof fetch;
  process.env.DATABASE_URL = "postgresql://owed:pw@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  delete process.env.OWED_BASE_URL;
  delete process.env.HELIUS_API_KEY;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) await pg.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
});

/** One USDC transfer from `payer` to `recipient` carrying `ref` (jsonParsed shape, as the RPC returns it). */
function paymentTx(sig: string, payer: string, recipient: string, amount: bigint, ref: string) {
  const payerAta = key(`ata of ${payer}`);
  const recipientAta = key(`ata of ${recipient}`);
  const keys = [payer, payerAta, recipientAta, USDC, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", ref];
  return {
    slot: 400_000_000, blockTime: Math.floor(Date.now() / 1000), version: "legacy",
    meta: {
      err: null, preBalances: keys.map(() => 1_000_000), postBalances: keys.map(() => 1_000_000),
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: payer, uiTokenAmount: { amount: String(amount * 2n) } },
        { accountIndex: 2, mint: USDC, owner: recipient, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: payer, uiTokenAmount: { amount: String(amount) } },
        { accountIndex: 2, mint: USDC, owner: recipient, uiTokenAmount: { amount: String(amount) } },
      ],
      innerInstructions: [],
    },
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })),
        instructions: [
          { program: "spl-token", parsed: { type: "transferChecked", info: { source: payerAta, mint: USDC, destination: recipientAta, authority: payer, signers: [ref], tokenAmount: { amount: String(amount), decimals: 6 } } } },
          { program: "spl-memo", parsed: "owed:settle" },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------- routes

const BASE = "https://owed-preview.example";
let ipSeq = 0;
const post = (route: (req: Request, ctx: never) => Promise<Response>, path: string, body: unknown, id?: string) =>
  route(
    new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `203.0.113.${(++ipSeq % 250) + 1}` }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) } as never,
  );
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string } }).error;
const read = async (id: string, chainCheck = false) => {
  const res = await getLedgerRoute(new Request(`${BASE}/api/v1/ledgers/${id}${chainCheck ? "" : "?chain=0"}`), { params: Promise.resolve({ id }) } as never);
  assert.equal(res.status, 200, await res.clone().text());
  return GroupLedgerResponse.parse(await res.json());
};

type Member = { name: string; payer?: Record<string, string> };
async function start(title: string, members: Member[], owner = RAJ, ownerName = "Raj") {
  const res = await post(createLedgerRoute as never, "/api/v1/ledgers", { title, owner: owner.address, owner_name: ownerName, members, source: "plugin" });
  assert.equal(res.status, 201, await res.clone().text());
  return GroupLedgerResponse.parse(await res.json());
}

/** An add-expense body as the plugin builds it: member positions, amounts as given, and the signed message over its digest. */
interface ExpenseArgs {
  paid_by: number;
  amount: string;
  currency?: string;
  description?: string;
  split: "even" | "shares" | "exact" | "items";
  among?: number[];
  shares?: Array<{ member: number; shares: string }>;
  amounts?: Array<{ member: number; amount: string }>;
  items?: Array<{ description?: string; amount: string; members: number[] }>;
  tax?: string;
  tip?: string;
}
function canonical(memberCount: number, a: ExpenseArgs): CanonicalExpense {
  const code = a.currency ?? "USDC";
  const d = code === "USDC" ? 6 : FIAT_CURRENCIES[code as keyof typeof FIAT_CURRENCIES]?.decimals ?? 2;
  const u = (s: string) => decimalToUnits(s, d);
  return {
    description: ledgerText(a.description, 80), paidBy: a.paid_by, currency: code, totalUnits: u(a.amount), split: a.split,
    among: a.split === "even" ? (a.among ?? Array.from({ length: memberCount }, (_, i) => i)) : null,
    shares: a.shares?.map((s) => ({ member: s.member, weight: decimalToUnits(s.shares, WEIGHT_DECIMALS) })) ?? null,
    amounts: a.amounts?.map((x) => ({ member: x.member, units: u(x.amount) })) ?? null,
    items: a.items?.map((i) => ({ description: ledgerText(i.description, 60), units: u(i.amount), members: i.members })) ?? null,
    taxUnits: a.tax ? u(a.tax) : null, tipUnits: a.tip ? u(a.tip) : null,
  };
}
function signedExpense(ledger: { id: string; members: unknown[] }, signer: ReturnType<typeof wallet>, a: ExpenseArgs, at = isoNow()) {
  const c = canonical(ledger.members.length, a);
  const d = c.currency === "USDC" ? 6 : FIAT_CURRENCIES[c.currency as keyof typeof FIAT_CURRENCIES]?.decimals ?? 2;
  const message = `${expensePrefix(ledger.id, expenseDigest(ledger.id, c), unitsToDecimal(c.totalUnits, d), c.currency, signer.address)} at ${at}`;
  return { signer: signer.address, ...a, signed_message: message, signature: signer.sign(message) };
}
const addExpense = (id: string, body: unknown) => post(addExpenseRoute as never, `/api/v1/ledgers/${id}/expenses`, body, id);
async function added(id: string, body: unknown) {
  const res = await addExpense(id, body);
  assert.equal(res.status, 201, await res.clone().text());
  return AddExpenseResponse.parse(await res.json());
}
function signedSettle(ledger: GroupLedgerResponse, signer: ReturnType<typeof wallet>, count: number, total: string, at = isoNow()) {
  const message = `${settlePrefix(ledger.id, ledger.version, count, total, signer.address)} at ${at}`;
  return { signer: signer.address, version: ledger.version, signed_message: message, signature: signer.sign(message) };
}
const settle = (id: string, body: unknown) => post(settleRoute as never, `/api/v1/ledgers/${id}/settle`, body, id);
const payable = (l: GroupLedgerResponse) => {
  const p = l.plan.filter((t) => t.payable);
  return { count: p.length, total: unitsToDecimal(p.reduce((a, t) => a + decimalToUnits(t.amount, 6), 0n), 6) };
};

/** Every key path in a value (arrays merged over their entries, null merged into whatever else is there). */
function keyTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keyTree).reduce((a, b) => merge(a, b), "*");
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, keyTree((value as Record<string, unknown>)[k])]));
  return "*";
}
function merge(a: unknown, b: unknown): unknown {
  if (a === "*") return b;
  if (b === "*") return a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? merge(out[k], v) : v;
  return Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
}
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));

// The acceptance receipt (cents): Raj 0, Priya 1, Sam 2, Alex 3.
const RECEIPT_ITEMS = [
  { description: "Bacalhau", amount: "18.50", members: [0] },
  { description: "Risotto", amount: "16.90", members: [1] },
  { description: "Octopus to share", amount: "21.00", members: [2, 3] },
  { description: "Olives and bread", amount: "9.99", members: [0, 1, 2] },
  { description: "Vinho verde", amount: "24.00", members: [0, 1, 2, 3] },
  { description: "Espressos", amount: "7.01", members: [1, 3] },
];

// ---------------------------------------------------------------- tests

let trip: GroupLedgerResponse;

it("POST /ledgers: the owner is member 0, payer identities are stored as F1 stores them, nothing is owed yet", async () => {
  trip = await start("Lisbon trip", [
    { name: "Priya", payer: { handle: "@Priya_P", wallet: PRIYA.address } },
    { name: "Sam", payer: { wallet: SAM.address } },
    { name: "Alex" },
  ]);
  assert.match(trip.id, /^[1-9A-HJ-NP-Za-km-z]{12}$/);
  assert.equal(trip.link, `${BASE}/l/${trip.id}`);
  assert.deepEqual(trip.members, [
    { position: 0, name: "Raj", wallet: RAJ.address, handle: null, sns: null },
    { position: 1, name: "Priya", wallet: PRIYA.address, handle: "priya_p", sns: null },
    { position: 2, name: "Sam", wallet: SAM.address, handle: null, sns: null },
    { position: 3, name: "Alex", wallet: null, handle: null, sns: null },
  ]);
  assert.deepEqual([trip.owner, trip.version, trip.expenses, trip.plan, trip.settlements, trip.settled], [RAJ.address, 0, [], [], [], false]);
  assert.ok(trip.balances.every((b) => b.net === "0" && b.to_settle === "0"));
  assert.equal(trip.caution, LEDGER_CAUTION);
  assert.deepEqual(trip.totals, { spent: "0", expense_count: 0, open_requests: 0 });
  assert.equal(trip.fiat_beside, null);
  assert.deepEqual(keyTree(trip), keyTree(fixture("ledgers.create.res.json")), "the fixture has exactly the server's fields");
});

it("POST /ledgers refuses duplicate names, the owner's wallet as a member, a shared wallet, a token account owner and unreadable text", async () => {
  const before = Number((await sql("select count(*)::text as n from ledgers"))[0]!.n);
  const base = { title: "Trip", owner: RAJ.address, owner_name: "Raj", source: "plugin" };
  for (const [patch, why] of [
    [{ members: [{ name: "RAJ" }] }, /two members are called/],
    [{ members: [{ name: "Priya", payer: { wallet: RAJ.address } }] }, /recipient's own wallet/],
    [{ members: [{ name: "Priya", payer: { wallet: PRIYA.address } }, { name: "Sam", payer: { wallet: PRIYA.address } }] }, /already another member's/],
    [{ owner: TEAM_ATA, members: [{ name: "Priya" }] }, /owner: must be the owner's Solana wallet/],
    [{ title: " ​ ", members: [{ name: "Priya" }] }, /title: needs some readable text/],
    [{ members: [{ name: "https://evil.example" }] }, /members\.0\.name: needs some readable text/],
    [{ members: [{ name: "Priya", payer: { handle: "@priya" } }] }, /resolve members\.0\.payer\.handle with PayBox resolve_username first/],
    [{ members: [] }, /members/],
  ] as const) {
    const res = await post(createLedgerRoute as never, "/api/v1/ledgers", { ...base, ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.match((await errorOf(res)).message, why, JSON.stringify(patch));
  }
  assert.equal(Number((await sql("select count(*)::text as n from ledgers"))[0]!.n), before, "nothing was created");
});

it("acceptance: 5 expenses paid by 3 of the 4, recorded by the owner and by members with their own wallets", async () => {
  let l = trip;
  const steps: Array<[ReturnType<typeof wallet>, ExpenseArgs]> = [
    [RAJ, { paid_by: 0, amount: "120", description: "Apartment, 3 nights", split: "even" }],
    [PRIYA, { paid_by: 1, amount: "45.5", description: "Groceries", split: "even", among: [1, 2, 3] }],
    [SAM, { paid_by: 2, amount: "60", description: "Car rental", split: "shares", shares: [{ member: 0, shares: "1" }, { member: 2, shares: "2" }, { member: 3, shares: "1" }] }],
    [RAJ, { paid_by: 0, amount: "33.33", description: "Museum tickets", split: "exact", amounts: [{ member: 1, amount: "13.33" }, { member: 3, amount: "20" }] }],
    [RAJ, { paid_by: 1, amount: "114.13", description: "Dinner at Taberna", split: "items", items: RECEIPT_ITEMS, tax: "6.73", tip: "10" }],
  ];
  for (const [i, [signer, args]] of steps.entries()) {
    const res = await added(l.id, signedExpense(l, signer, args));
    assert.equal(res.added, i);
    assert.equal(res.ledger.version, i + 1);
    l = res.ledger;
  }
  assert.deepEqual(l.balances.map((b) => b.net), ["75.719754", "66.290873", "-38.402785", "-103.607842"]);
  assert.equal(l.totals.spent, "372.96");
  assert.deepEqual(l.plan, [
    { from: 3, to: 0, amount: "75.719754", payable: true },
    { from: 2, to: 1, amount: "38.402785", payable: true },
    { from: 3, to: 1, amount: "27.888088", payable: true },
  ]);
  const dinner = l.expenses[4]!;
  assert.deepEqual(dinner.items!.map((i) => [i.description, i.amount, i.members]), RECEIPT_ITEMS.map((i) => [i.description, i.amount.replace(/\.?0+$/, ""), i.members]));
  assert.deepEqual([dinner.tax, dinner.tip, dinner.currency, dinner.total, dinner.amount, dinner.fiat], ["6.73", "10", "USDC", "114.13", "114.13", null]);
  assert.equal(dinner.shares.reduce((a, s) => a + decimalToUnits(s.amount, 6), 0n), 114_130_000n, "the receipt splits exactly");
  assert.deepEqual(l.expenses.map((e) => e.recorded_by), [RAJ.address, PRIYA.address, SAM.address, RAJ.address, RAJ.address]);
  assert.deepEqual(keyTree({ added: 4, ledger: l }), keyTree(fixture("ledgers.expense.res.json")), "the fixture has exactly the server's fields");
  assert.deepEqual(l.expenses[2]!.shares.map((s) => [s.member, s.weight, s.amount]), [[0, "1", "15"], [2, "2", "30"], [3, "1", "15"]]);
  // Every stored expense carries the signature over its digest, which anyone can recompute from what is stored.
  for (const e of l.expenses) {
    const c: CanonicalExpense = {
      description: e.description, paidBy: e.paid_by, currency: e.currency, totalUnits: decimalToUnits(e.total, 6), split: e.split,
      among: e.split === "even" ? e.shares.map((s) => s.member) : null,
      shares: e.split === "shares" ? e.shares.map((s) => ({ member: s.member, weight: decimalToUnits(s.weight!, WEIGHT_DECIMALS) })) : null,
      amounts: e.split === "exact" ? e.shares.map((s) => ({ member: s.member, units: decimalToUnits(s.share, 6) })) : null,
      items: e.items?.map((i) => ({ description: i.description, units: decimalToUnits(i.amount, 6), members: i.members })) ?? null,
      taxUnits: e.tax === null ? null : decimalToUnits(e.tax, 6), tipUnits: e.tip === null ? null : decimalToUnits(e.tip, 6),
    };
    assert.ok(e.signed_message.startsWith(`Owed add expense ${expenseDigest(l.id, c)} (${e.total} USDC) to ledger ${l.id} by ${e.recorded_by} at `), e.signed_message);
  }
  trip = l;
});

it("add_expense: only a wallet in the ledger, only over exactly this expense, once, and only fresh", async () => {
  const args: ExpenseArgs = { paid_by: 2, amount: "12", description: "Taxi", split: "even" };
  const outsider = await addExpense(trip.id, signedExpense(trip, MALLORY, args));
  assert.equal(outsider.status, 403);
  assert.match((await errorOf(outsider)).message, /only the ledger's owner or a member whose wallet is in it/);
  const body = signedExpense(trip, SAM, args);
  const tampered = await addExpense(trip.id, { ...body, amount: "120" });
  assert.equal(tampered.status, 400);
  assert.match((await errorOf(tampered)).message, /signed_message must read "Owed add expense [0-9a-f]{16} \(120 USDC\)/);
  const moved = await addExpense(trip.id, { ...body, among: [0, 1, 2] });
  assert.equal(moved.status, 400, "the split is part of what was signed");
  const stolen = await addExpense(trip.id, { ...body, signer: RAJ.address });
  assert.equal(stolen.status, 400, "another member's wallet can't sign for this one");
  const stale = signedExpense(trip, SAM, args, new Date(Date.now() - 6 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"));
  assert.match((await errorOf(await addExpense(trip.id, stale))).message, /more than 5 minutes old/);
  for (const [bad, why] of [
    [{ ...args, split: "exact", amounts: [{ member: 0, amount: "5" }] }, /exact amounts add up to/],
    [{ ...args, paid_by: 7 }, /paid_by: names someone who isn't in this ledger/],
    [{ ...args, among: [2, 0] }, /each member once, in ledger order/],
    [{ ...args, currency: "USD" }, /currency: USD needs no conversion/],
    [{ ...args, amount: "0" }, /amount: must be more than zero/],
    [{ ...args, split: "items", items: [{ amount: "10", members: [0] }], tip: "1" }, /items \(10000000\) plus tax \(0\) and tip \(1000000\) add up to 11000000 units, not the expense's 12000000/],
  ] as const) {
    const res = await addExpense(trip.id, signedExpense(trip, SAM, bad as ExpenseArgs));
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match((await errorOf(res)).message, why, JSON.stringify(bad));
  }
  assert.equal((await read(trip.id)).version, trip.version, "nothing was recorded");
  const missing = await addExpense("1111111111ab", body);
  assert.equal(missing.status, 404);
});

it("a local-currency receipt: split to the cent in euros, each share locked to USDC at one live rate under the two-source rule", async () => {
  resetFxCache();
  let l = await start("Porto weekend", [{ name: "Priya", payer: { wallet: PRIYA.address } }, { name: "Sam" }, { name: "Alex" }]);
  const res = await added(l.id, signedExpense(l, RAJ, { paid_by: 0, amount: "114.13", currency: "EUR", description: "Dinner", split: "items", items: RECEIPT_ITEMS, tax: "6.73", tip: "10" }));
  l = res.ledger;
  const e = l.expenses[0]!;
  assert.deepEqual([e.currency, e.total, e.tax, e.tip], ["EUR", "114.13", "6.73", "10"]);
  assert.deepEqual(e.shares.map((s) => s.share), ["32.62", "34.85", "23.23", "23.43"], "to the cent, leftovers to the first members");
  assert.equal(e.fiat?.rate_source, "api.coinbase.com, checked against open.er-api.com");
  assert.deepEqual([e.fiat?.currency, e.fiat?.amount], ["EUR", "114.13"]);
  let sum = 0n;
  for (const s of e.shares) {
    const atomic = usdcAtomicFor(fromMinor(decimalToUnits(s.share, 2), "EUR"), "EUR", e.fiat!.rate);
    assert.equal(decimalToUnits(s.amount, 6), atomic, `${s.share} EUR rounds up to ${s.amount} USDC`);
    sum += atomic;
  }
  assert.equal(decimalToUnits(e.amount, 6), sum, "the payer is credited the shares' USDC sum");
  assert.deepEqual(l.fiat_beside, { currency: "EUR", rate: e.fiat!.rate, rate_source: e.fiat!.rate_source, quoted_at: e.fiat!.quoted_at });
  assert.equal(l.balances[0]!.net, unitsToDecimal(sum - decimalToUnits(e.shares[0]!.amount, 6), 6));

  // The two sources more than 2% apart: no rate, no expense, and the signature isn't spent.
  resetFxCache();
  coinbase = coinbase.replace(/"EUR":"[^"]*"/, '"EUR":"0.99"');
  const body = signedExpense(l, RAJ, { paid_by: 0, amount: "10", currency: "EUR", split: "even" });
  const refused = await addExpense(l.id, body);
  assert.equal(refused.status, 503);
  assert.match((await errorOf(refused)).message, /disagree on EUR by .* \(more than 2%\)/);
  assert.equal((await read(l.id)).expenses.length, 1);
  resetFxCache();
  coinbase = fx("coinbase-usd.json");
  const recorded = await addExpense(l.id, body);
  assert.equal(recorded.status, 201, "the same signature works once the rate locks");
  assert.deepEqual(keyTree(AddExpenseResponse.parse(await recorded.json())), keyTree(fixture("ledgers.expense.fiat.res.json")));
  const replay = await addExpense(l.id, body);
  assert.equal(replay.status, 400);
  assert.match((await errorOf(replay)).message, /this signature was already used/);
});

let round: SettleUpResponse;

it("acceptance: settle_up creates at most 3 requests, payable to each creditor and addressed to each debtor's wallet", async () => {
  const { count, total } = payable(trip);
  assert.equal(count, 3);
  const res = await settle(trip.id, signedSettle(trip, SAM, count, total)); // a member settles, with his own wallet
  assert.equal(res.status, 201, await res.clone().text());
  round = SettleUpResponse.parse(await res.json());
  assert.deepEqual(keyTree(round), keyTree(fixture("ledgers.settle.res.json")), "the fixture has exactly the server's fields");
  assert.equal(round.round, trip.version);
  assert.equal(round.created.length, 3);
  assert.deepEqual(round.unpayable, []);
  const wallets = trip.members.map((m) => m.wallet);
  for (const [i, c] of round.created.entries()) {
    const planned = trip.plan[i]!;
    assert.deepEqual([c.from, c.to, c.amount], [planned.from, planned.to, planned.amount]);
    const r = c.request;
    assert.equal(r.recipient, wallets[c.to]);
    assert.deepEqual(r.payer, wallets[c.from] ? { wallet: wallets[c.from], handle: trip.members[c.from]!.handle, sns: null } : null);
    assert.equal(r.for, "Lisbon trip settle-up");
    assert.equal(r.note, `Settle-up from Owed ledger ${trip.id}, recorded by Sam.`);
    assert.equal(r.payer_name, trip.members[c.from]!.name);
    assert.equal(r.requester_name, trip.members[c.to]!.name);
    assert.equal(r.requester_handle, trip.members[c.to]!.handle);
    // The id commits to recipient, asset, amount and reference, like every Owed request.
    const digest = createHash("sha256").update(`owed-request:v1\n${r.recipient}\n${USDC}\n${decimalToUnits(c.amount, 6)}\n${r.reference}`, "utf8").digest();
    assert.equal(bs58.encode(digest).slice(-12), r.id);
    const url = new URL(r.solana_pay_url);
    assert.equal(url.pathname, r.recipient);
    assert.deepEqual([url.searchParams.get("amount"), url.searchParams.get("spl-token"), url.searchParams.get("reference"), url.searchParams.get("memo")], [c.amount, USDC, r.reference, `owed:${r.id}`]);
  }
  const after = round.ledger;
  assert.equal(after.version, trip.version + 1);
  assert.ok(after.balances.every((b) => b.to_settle === "0"), "nothing left to settle");
  assert.deepEqual(after.balances.map((b) => b.net), trip.balances.map((b) => b.net), "nothing has moved yet");
  assert.deepEqual(after.plan, []);
  assert.equal(after.totals.open_requests, 3);
  assert.equal(after.settlements[0]!.recorded_by, SAM.address);
  assert.deepEqual(after.settlements[0]!.transfers.map((t) => [t.status, t.addressed]), [["open", false], ["open", true], ["open", false]]);
  trip = after;
});

it("a settle-up request lands in the debtor's what_do_i_owe inbox, naming the ledger", async () => {
  const message = `Owed inbox access for ${SAM.address} at ${isoNow()}`;
  const res = await post(inboxRoute as never, "/api/v1/inbox", { payer: SAM.address, signed_message: message, signature: SAM.sign(message) });
  assert.equal(res.status, 200, await res.clone().text());
  const box = InboxResponse.parse(await res.json());
  const mine = round.created.filter((c) => c.from === 2).map((c) => c.request.id);
  const listed = box.owed.filter((e) => mine.includes(e.id));
  assert.equal(listed.length, 1);
  assert.deepEqual([listed[0]!.recipient, listed[0]!.amount, listed[0]!.for, listed[0]!.requester_name, listed[0]!.requester_handle], [
    PRIYA.address, "38.402785", "Lisbon trip settle-up", "Priya", "priya_p",
  ]);
});

it("settle_up again: nothing to settle; a stale version or another wallet's signature is refused", async () => {
  const again = await settle(trip.id, signedSettle(trip, RAJ, 1, "1"));
  assert.equal(again.status, 400);
  assert.match((await errorOf(again)).message, /nothing to settle/);
  const stale = await settle(trip.id, { ...signedSettle(trip, RAJ, 1, "1"), version: trip.version - 1 });
  assert.match((await errorOf(stale)).message, /changed since this was signed \(it is at version \d+ now\)/);
  const outsider = await settle(trip.id, signedSettle(trip, MALLORY, 1, "1"));
  assert.equal(outsider.status, 403);
});

it("acceptance: paying the settle-up requests on chain zeroes every balance", async () => {
  const debtors = [wallet("alex's own wallet, outside the ledger"), SAM];
  for (const [i, c] of round.created.entries()) {
    const payer = c.request.payer?.wallet ?? debtors[0]!.address;
    const sig = bs58.encode(createHash("sha512").update(`settle-up payment ${i}`).digest());
    chain.push({ refs: [c.request.reference], tx: paymentTx(sig, payer, c.request.recipient, decimalToUnits(c.amount, 6), c.request.reference) });
  }
  await new Promise((resolve) => setTimeout(resolve, 3100)); // lib/requests.ts checks one request on chain at most every 3 s
  const l = await read(trip.id, true);
  assert.equal(l.chain_checked, true);
  assert.deepEqual(l.settlements[0]!.transfers.map((t) => t.status), ["paid", "paid", "paid"]);
  assert.ok(l.balances.every((b) => b.net === "0" && b.to_settle === "0" && b.pending_in === "0" && b.pending_out === "0"), JSON.stringify(l.balances));
  assert.deepEqual(l.balances.map((b) => [b.sent, b.received]), [["0", "75.719754"], ["0", "66.290873"], ["38.402785", "0"], ["103.607842", "0"]]);
  assert.equal(l.settled, true);
  assert.equal(l.totals.open_requests, 0);
  assert.deepEqual(keyTree(l), keyTree(fixture("ledgers.get.res.json")), "the fixture has exactly the server's fields");
});

it("a creditor without a wallet can't be paid: listed as unpayable, never created", async () => {
  let l = await start("Flat bills", [{ name: "Sam", payer: { wallet: SAM.address } }, { name: "Alex" }]);
  l = (await added(l.id, signedExpense(l, RAJ, { paid_by: 2, amount: "30", description: "Internet", split: "even" }))).ledger; // Alex paid
  l = (await added(l.id, signedExpense(l, RAJ, { paid_by: 0, amount: "9", description: "Cleaning", split: "even", among: [0, 1] }))).ledger;
  assert.deepEqual(l.plan.map((t) => [t.from, t.to, t.amount, t.payable]), [[1, 2, "14.5", false], [0, 2, "5.5", false]]);
  const none = await settle(l.id, signedSettle(l, RAJ, 0, "0"));
  assert.equal(none.status, 400);
  assert.match((await errorOf(none)).message, /nobody who is owed money has a wallet in this ledger/);
  // Once Sam is owed too, his transfer is created and Alex's is listed apart.
  // Raj -20.5, Sam +15.5, Alex +5: Raj pays Sam through Owed; Alex's 5 stays listed, with nothing created for it.
  l = (await added(l.id, signedExpense(l, SAM, { paid_by: 1, amount: "45", description: "Groceries", split: "even" }))).ledger;
  assert.deepEqual(l.plan.map((t) => [t.from, t.to, t.amount, t.payable]), [[0, 1, "15.5", true], [0, 2, "5", false]]);
  const { count, total } = payable(l);
  const res = await settle(l.id, signedSettle(l, SAM, count, total));
  assert.equal(res.status, 201, await res.clone().text());
  const s = SettleUpResponse.parse(await res.json());
  assert.deepEqual(s.created.map((c) => [c.from, c.to, c.amount, c.request.recipient]), [[0, 1, "15.5", SAM.address]]);
  assert.deepEqual(s.unpayable, [{ from: 0, to: 2, amount: "5", reason: "no_wallet" }]);
  assert.deepEqual(s.ledger.plan, [{ from: 0, to: 2, amount: "5", payable: false }], "still owed, still listed");
});

it("a cancelled settle-up request puts its debt back, once the chain confirms it wasn't paid", async () => {
  let l = await start("Ski chalet", [{ name: "Priya", payer: { wallet: PRIYA.address } }]);
  l = (await added(l.id, signedExpense(l, RAJ, { paid_by: 0, amount: "50", split: "even" }))).ledger;
  const first = SettleUpResponse.parse(await (await settle(l.id, signedSettle(l, PRIYA, 1, "25"))).json());
  const id = first.created[0]!.request.id;
  await sql("update requests set status = 'cancelled', cancelled_at = now(), cancel_message = $2, cancel_signature = $3 where id = $1", [id, `Owed cancel ${id}`, "c".repeat(128)]);
  l = await read(l.id, true);
  assert.deepEqual(l.plan, [{ from: 1, to: 0, amount: "25", payable: true }]);
  await new Promise((resolve) => setTimeout(resolve, 3100)); // past lib/requests.ts's 3 s re-check window
  chainDown = true;
  const blind = await settle(l.id, signedSettle(l, PRIYA, 1, "25"));
  assert.equal(blind.status, 503, "a cancelled request may have been paid late: no new ask without the chain");
  chainDown = false;
  const again = await settle(l.id, signedSettle(l, PRIYA, 1, "25"));
  assert.equal(again.status, 201, await again.clone().text());
  const s = SettleUpResponse.parse(await again.json());
  assert.notEqual(s.created[0]!.request.id, id);
  assert.deepEqual(s.ledger.settlements.map((r) => r.transfers.map((t) => t.status)), [["cancelled"], ["open"]]);
});

it("brand words in a ledger flag it and every settle-up request it creates (pay pages and inboxes show the caution)", async () => {
  let l = await start("PayBox support refund", [{ name: "Sam \"the admin\"", payer: { handle: "@paybox_help", wallet: SAM.address } }]);
  assert.ok(l.flags.includes("brand_word:paybox"), JSON.stringify(l.flags));
  assert.equal(l.members[1]!.name, "Sam 'the admin'", "double quotes become single quotes, as everywhere");
  l = (await added(l.id, signedExpense(l, RAJ, { paid_by: 0, amount: "2", description: "Fee \"verify\" https://paybox.help/x", split: "even" }))).ledger;
  assert.equal(l.expenses[0]!.description, "Fee verify", "the description keeps only plain words");
  assert.ok(l.expenses[0]!.flags.includes("brand_word:paybox"), "a brand word in a stripped link still flags");
  const s = SettleUpResponse.parse(await (await settle(l.id, signedSettle(l, SAM, 1, "1"))).json());
  const [row] = await sql("select array_to_json(flags)::text as flags, for_text, note from requests where id = $1", [s.created[0]!.request.id]);
  assert.ok(JSON.parse(row!.flags!).includes("brand_word:paybox"), row!.flags!);
  assert.equal(row!.for_text, "PayBox support refund settle-up");
  assert.equal(row!.note, `Settle-up from Owed ledger ${l.id}, recorded by Sam 'the admin'.`);
});

it("the database refuses malformed members, expenses and transfers", async () => {
  const id = trip.id;
  await assert.rejects(pg.query("insert into ledger_members (ledger_id, position, name, handle) values ($1, 9, 'X', 'x')", [id]), /ledger_members_payer_check/);
  await assert.rejects(pg.query("insert into ledger_members (ledger_id, position, name) values ($1, 4, 'raj')", [id]), /ledger_members_name_key/);
  await assert.rejects(
    pg.query(`insert into ledger_expenses (ledger_id, position, paid_by, split, total_units, amount_atomic, tax_units, recorded_by, signed_message, signature)
              values ($1, 99, 0, 'even', 5, 5, 1, $2, 'm', $3)`, [id, RAJ.address, "a".repeat(64)]),
    /ledger_expenses_extras_check/,
  );
  await assert.rejects(
    pg.query(`insert into ledger_expenses (ledger_id, position, paid_by, split, currency, total_units, amount_atomic, recorded_by, signed_message, signature)
              values ($1, 98, 0, 'even', 'USD', 5, 5, $2, 'm', $3)`, [id, RAJ.address, "a".repeat(64)]),
    /ledger_expenses_currency_check/,
  );
  await assert.rejects(
    pg.query("insert into ledger_transfers (ledger_id, round, position, from_member, to_member, amount_atomic, request_id) values ($1, 0, 0, 1, 1, 1, 'x')", [id]),
    /ledger_transfers_members_check|foreign key/,
  );
});
