import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { check, groupIdFor as shapesGroupIdFor, shapes } from "../../contract/shapes.mjs";
import { GroupResponse } from "@/lib/contract";
import { groupIdFor, isGroupId, MAX_PEOPLE, planShares, toPublicGroup, type GroupWithShares } from "@/lib/groups";
import { requestIdFor } from "@/lib/ids";
import { AmountError } from "@/lib/money";
import type { RequestRow } from "@/lib/requests";
import { POST } from "@/app/api/v1/groups/route";
import { GET } from "@/app/api/v1/groups/[id]/route";

const fixtures = new URL("../../contract/fixtures/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, fixtures), "utf8"));
const RECIPIENT = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";

// ---- pure helpers ----

test("planShares: even split, leftover atomic units to the first people", () => {
  assert.deepEqual(planShares(10_000_000n, [null, null, null]), [3_333_334n, 3_333_333n, 3_333_333n]);
  assert.deepEqual(planShares(5n, [null, null, null]), [2n, 2n, 1n]);
  assert.deepEqual(planShares(1_500_000n, [null, null, null]), [500_000n, 500_000n, 500_000n]);
});

test("planShares: set amounts are kept, the rest splits evenly", () => {
  assert.deepEqual(planShares(2_500_000n, [null, 1_000_000n, null, null]), [500_000n, 1_000_000n, 500_000n, 500_000n]);
  assert.deepEqual(planShares(3_000_000n, [2_000_000n, 1_000_000n]), [2_000_000n, 1_000_000n]);
});

test("planShares: refuses splits that can't add up", () => {
  const refuses = (total: bigint, amounts: Array<bigint | null>, message: RegExp) =>
    assert.throws(() => planShares(total, amounts), (e: unknown) => e instanceof AmountError && message.test(e.message));
  refuses(3_000_000n, [2_000_000n, 2_000_000n], /add up to the total/);
  refuses(1_000_000n, [1_000_000n, null], /nothing is left/);
  refuses(2n, [null, null, null], /too small/);
  refuses(10n, [null], /between 2 and 20/);
  refuses(100n, Array(MAX_PEOPLE + 1).fill(null), /between 2 and 20/);
  refuses(10n, [0n, null], /more than zero/);
});

test("group ids: same derivation as contract/shapes.mjs and the fixtures", () => {
  for (const name of ["groups.create.res.json", "groups.get.res.json"]) {
    const g = fixture(name);
    const terms = { recipient: g.recipient, token: g.token, totalAtomic: 1_500_000n, shareIds: g.shares.map((s: { id: string }) => s.id) };
    assert.equal(groupIdFor(terms), g.id);
    assert.equal(shapesGroupIdFor(terms), g.id);
  }
  assert.equal(isGroupId("TompKg61uDGV"), true);
  assert.equal(isGroupId("TompKg61uDG"), false);
  assert.equal(isGroupId("TompKg61uDG0"), false);
});

interface FixtureShare { id: string; name: string; status: RequestRow["status"]; reference: string; paid: { signature: string; payer: string; at: string } | null }

function rowsFromFixture(g: ReturnType<typeof fixture>): GroupWithShares {
  const shares: RequestRow[] = (g.shares as FixtureShare[]).map((s) => ({
    id: s.id, kind: "split_share", recipient: g.recipient, token: g.token, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6, amountAtomic: 500_000n, reference: s.reference, payerName: s.name, forText: g.title, note: null,
    requesterName: g.requester_name, flags: [], status: s.status, paidSignature: s.paid?.signature ?? null,
    paidPayer: s.paid?.payer ?? null, paidAmountAtomic: s.paid ? 500_000n : null, paidAt: s.paid?.at ?? null,
    paidRail: s.paid ? "solana_pay" : null, source: "plugin", createdAt: g.created_at,
  }));
  return {
    group: {
      id: g.id, title: g.title, recipient: g.recipient, token: g.token, totalAtomic: 1_500_000n, requesterName: g.requester_name,
      flags: [], source: "plugin", fromDomain: null, fromDomainVerifiedAt: null, createdAt: g.created_at, shareIds: shares.map((s) => s.id),
    },
    shares,
  };
}

test("toPublicGroup produces exactly the contract fixtures (open and 2 of 3 paid)", () => {
  for (const name of ["groups.create.res.json", "groups.get.res.json"]) {
    const expected = fixture(name);
    assert.deepEqual(toPublicGroup(rowsFromFixture(expected), "https://owed.link"), expected);
  }
});

// ---- the routes against an in-memory Neon endpoint and an empty chain ----

interface Stored { [column: string]: string | null }
const db = { groups: new Map<string, Stored>(), requests: new Map<string, Stored>(), rateEvents: 0, failNextInsert: "" };
const realFetch = globalThis.fetch;
const realEnv = { DATABASE_URL: process.env.DATABASE_URL, OWED_BASE_URL: process.env.OWED_BASE_URL };

function result(fields: string[], rows: Array<Array<string | null>>) {
  return { fields: fields.map((name) => ({ name, dataTypeID: 25 })), rows };
}

function runQuery(text: string, params: Array<string | null>) {
  if (text.startsWith("delete from rate_events")) return result([], []); // ratelimit.ts trims old events now and then
  if (text.includes("from rate_events")) {
    db.rateEvents += 1;
    return result(["allowed", "recipient_ok", "retry_recipient", "retry_global", "recorded"], [["t", "t", "1", "1", "2"]]);
  }
  if (text.startsWith("insert into groups")) {
    const [id, title, recipient, token, total, requester, flags, source, fromDomain] = params;
    const verifiedAt = fromDomain === null ? null : "2026-10-17T07:30:00Z";
    db.groups.set(id!, {
      id, title, recipient, token, total_atomic: total, requester_name: requester, flags, source,
      from_domain: fromDomain, from_domain_verified_at: verifiedAt, created_at: "2026-10-17T07:30:00Z",
    });
    return result(["created_at", "from_domain_verified_at"], [["2026-10-17T07:30:00Z", verifiedAt]]);
  }
  if (text.includes("insert into requests")) {
    const [id, groupId, position, recipient, token, mint, decimals, amount, reference, name, title, requester, flags, source] = params;
    if (db.failNextInsert) {
      const constraint = db.failNextInsert;
      db.failNextInsert = "";
      throw Object.assign(new Error("duplicate key"), { neon: { code: "23505", constraint } });
    }
    db.requests.set(id!, {
      id, kind: "split_share", group_id: groupId, group_position: position, recipient, token, mint, decimals, amount_atomic: amount,
      reference, payer_name: name, for_text: title, note: null, requester_name: requester, flags, status: "open",
      paid_signature: null, paid_payer: null, paid_amount_atomic: null, paid_at: null, paid_rail: null, source, created_at: "2026-10-17T07:30:00Z",
    });
    return result([], []);
  }
  if (text.includes("from groups g where g.id = $1")) {
    const g = db.groups.get(params[0]!);
    if (!g) return result([], []);
    const shareIds = [...db.requests.values()].filter((r) => r.group_id === g.id).sort((a, b) => Number(a.group_position) - Number(b.group_position)).map((r) => r.id);
    const flags = JSON.stringify(g.flags === "{}" ? [] : g.flags!.slice(2, -2).split('","'));
    return result(Object.keys({ ...g, share_ids: "" }), [[...Object.values({ ...g, flags }), JSON.stringify(shareIds)]]);
  }
  if (text.includes("from requests where id = any($1::text[])")) {
    const ids = params[0]!.slice(1, -1).split(",").map((s) => s.replace(/"/g, ""));
    const rows = ids.map((id) => db.requests.get(id)).filter((r): r is Stored => !!r);
    const columns = ["id", "kind", "recipient", "token", "mint", "decimals", "amount_atomic", "reference", "payer_name", "for_text", "note",
      "requester_name", "flags", "status", "paid_signature", "paid_payer", "paid_amount_atomic", "paid_at", "paid_rail", "source", "created_at"];
    return result(columns, rows.map((r) => columns.map((c) => (c === "flags" ? "[]" : r[c] ?? null))));
  }
  throw new Error(`unexpected query: ${text.slice(0, 80)}`);
}

beforeEach(() => {
  db.groups.clear();
  db.requests.clear();
  db.rateEvents = 0;
  process.env.DATABASE_URL = "postgresql://u:p@ep-test-pooler.us-east-1.aws.neon.tech/neondb";
  process.env.OWED_BASE_URL = "https://owed.link";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "null"));
    if (url.host === "api.us-east-1.aws.neon.tech") {
      try {
        if (body.queries) return Response.json({ results: body.queries.map((q: { query: string; params: Array<string | null> }) => runQuery(q.query.trim(), q.params)) });
        return Response.json(runQuery(body.query.trim(), body.params));
      } catch (e) {
        const neon = (e as { neon?: object }).neon;
        if (neon) return Response.json({ message: "duplicate key value violates unique constraint", ...neon }, { status: 400 });
        throw e;
      }
    }
    // Solana RPC: no transactions reference any share yet.
    const calls = Array.isArray(body) ? body : [body];
    return Response.json(calls.map((c: { id: number }) => ({ jsonrpc: "2.0", id: c.id, result: [] })));
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(realEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const post = (body: unknown) => POST(new Request("https://owed.link/api/v1/groups", { method: "POST", body: JSON.stringify(body) }));
const get = (id: string) => GET(new Request(`https://owed.link/api/v1/groups/${id}`), { params: Promise.resolve({ id }) } as never);

test("POST /groups: 201 with a contract-valid group, one share row per person, all derived ids", async () => {
  const res = await post(fixture("groups.create.req.json"));
  assert.equal(res.status, 201);
  const body = await res.json();
  GroupResponse.parse(body);
  assert.deepEqual(check(shapes.groupRes, body).errors, []);
  assert.equal(body.share_count, 3);
  assert.deepEqual(body.shares.map((s: { name: string; amount: string }) => [s.name, s.amount]), [["Priya", "0.5"], ["Sam", "0.5"], ["Alex", "0.5"]]);
  assert.equal(body.link, `https://owed.link/g/${body.id}`);
  assert.equal(db.groups.size, 1);
  assert.equal(db.requests.size, 3);
  assert.equal(db.rateEvents, 3, "every share takes one create slot");
  for (const [position, share] of body.shares.entries()) {
    const row = db.requests.get(share.id)!;
    assert.equal(row.group_id, body.id);
    assert.equal(row.group_position, String(position));
    assert.equal(row.amount_atomic, "500000");
    assert.equal(share.id, requestIdFor({ recipient: RECIPIENT, token: "USDC", amountAtomic: 500_000n, reference: share.reference }));
    assert.match(share.solana_pay_url, new RegExp(`memo=owed%3A${share.id}$`));
  }
});

test("POST /groups: untrusted text is sanitized and brand words are flagged on the group and its shares", async () => {
  const res = await post({
    recipient: RECIPIENT, total: "1", token: "USDC", title: "MoonPay refund at https://evil.example", requester_name: "Raj‮",
    people: [{ name: "Priya <script>" }, { name: "Sam" }],
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.title, "MoonPay refund at");
  assert.equal(body.requester_name, "Raj");
  assert.equal(body.shares[0].name, "Priya script");
  assert.deepEqual(body.flags, ["brand_word:moonpay", "brand_word:refund"]);
  assert.equal(db.requests.get(body.shares[1].id)!.flags, '{"brand_word:moonpay","brand_word:refund"}');
});

test("POST /groups: bad input is a contract 400", async () => {
  // The recipient's own USDC account: off-curve, the classic paste mistake.
  const tokenAccount = getAssociatedTokenAddressSync(
    new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), new PublicKey(RECIPIENT),
  ).toBase58();
  const cases: Array<[unknown, RegExp]> = [
    [{ ...fixture("groups.create.req.json"), people: [{ name: "Priya" }] }, /at least 2 people/],
    [{ ...fixture("groups.create.req.json"), total: "1.0000001" }, /decimal places/],
    [{ ...fixture("groups.create.req.json"), total: "2" }, /add up to the total/],
    [{ ...fixture("groups.create.req.json"), recipient: tokenAccount }, /wallet address, not a token account/],
    [{ ...fixture("groups.create.req.json"), recipient: "nope" }, /base58/],
    // Until W2-H's requireVerifiedDomain merges, a claimed domain is refused, never stored unverified.
    [{ ...fixture("groups.create.req.json"), from_domain: "getowed.xyz" }, /from_domain can't be verified/],
  ];
  for (const [body, message] of cases) {
    const res = await post(body);
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, "invalid_input");
    assert.match(json.error.message, message);
  }
  assert.equal(db.groups.size, 0);
});

test("POST /groups: a reference collision retries with fresh references", async () => {
  db.failNextInsert = "requests_reference_key";
  const res = await post(fixture("groups.create.req.json"));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(check(shapes.groupRes, body).errors, []);
});

test("GET /groups/:id: round trip, board order, checked on chain, 404 and 400", async () => {
  const created = await (await post(fixture("groups.create.req.json"))).json();
  const res = await get(created.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, created);

  // A share paid elsewhere (e.g. /status settled it) shows up in the totals.
  const paid = db.requests.get(created.shares[1].id)!;
  Object.assign(paid, {
    status: "paid", paid_signature: "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv",
    paid_payer: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", paid_amount_atomic: "500000", paid_at: "2026-10-17T07:41:12Z", paid_rail: "solana_pay",
  });
  const after = await (await get(created.id)).json();
  assert.deepEqual(check(shapes.groupRes, after).errors, []);
  assert.equal(after.paid_count, 1);
  assert.equal(after.amount_received, "0.5");
  assert.equal(after.shares[1].status, "paid");
  assert.equal(after.shares[1].paid.payer, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");

  const missing = await get("TompKg61uDGV");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "not_found");
  const bad = await get("not-an-id");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "invalid_input");
});
