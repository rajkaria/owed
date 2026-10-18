import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import bs58 from "bs58";
import { inputSchema, ledgerMessage, outputSchema, whoOwesMe, type WhoOutput } from "../src/tools/who_owes_me.ts";
import { fixture, json, makeDeps, textOf } from "./helpers.ts";

// F8 invoices in who_owes_me: "reminder due: polite|firm|formal" on an overdue invoice's chase days (the server's, or
// 3/7/14), refunds on paid lines, and a client's monthly statement on the second call. Signatures come from throwaway
// keys (fixed seeds, they hold nothing), the way PayBox's request_wallet_sign makes them.

function signer(label: string) {
  const seed = createHash("sha256").update(label).digest();
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const address = bs58.encode(createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32));
  return { address, sign: (text: string) => sign(null, Buffer.from(text, "utf8"), priv).toString("hex") };
}
const ME = signer("owed test signer: who_owes_me.test.ts");
const ledgerRes = fixture("ledger.res.json");
const LEDGER = "POST /api/v1/ledger";
// The fixture's invoice Hb7kQ2xRmN4p is due 2026-10-30.
const at = (date: string) => Date.parse(`${date}T10:30:00Z`);

function call(now: number, extra: Record<string, unknown> = {}) {
  const message = ledgerMessage(ME.address, now);
  return inputSchema.parse({ recipient: ME.address, signed_message: message, signature: ME.sign(message), ...extra });
}
const out = (result: Awaited<ReturnType<typeof whoOwesMe>>): WhoOutput => {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  return outputSchema.parse((result as { structuredContent: WhoOutput }).structuredContent);
};
const answer = (patch: (l: typeof ledgerRes) => void = () => undefined) => {
  const l = structuredClone({ ...ledgerRes, recipient: ME.address });
  patch(l);
  return l;
};

test("reminder due: none before day 3, polite from day 3, firm from day 7, formal from day 14 (default chase days)", async () => {
  const tone = async (date: string) => {
    const { deps } = makeDeps({ now: () => at(date), routes: { [LEDGER]: () => json(200, answer()) } });
    const o = out(await whoOwesMe(call(at(date)), deps));
    return o.open?.find((e) => e.kind === "invoice")?.reminder_due ?? null;
  };
  assert.equal(await tone("2026-11-01"), null);
  assert.deepEqual(await tone("2026-11-02"), { tone: "polite", days_overdue: 3, write_reminder: { request: ledgerRes.open[0].link, tone: "friendly" } });
  assert.equal((await tone("2026-11-06"))?.tone, "firm");
  assert.equal((await tone("2026-11-13"))?.tone, "formal");
  const { deps } = makeDeps({ now: () => at("2026-11-06"), routes: { [LEDGER]: () => json(200, answer()) } });
  const text = textOf(await whoOwesMe(call(at("2026-11-06")), deps));
  assert.ok(text.includes(`Reminder due: firm (7 days overdue); draft it with write_reminder (request ${ledgerRes.open[0].link}, tone "firm").`));
  // Only invoices have due dates; the other open requests get no reminder line.
  assert.equal(text.match(/Reminder due/g)?.length, 1);
});

test("the invoice's own chase days win: custom days, or off", async () => {
  const run = async (chase: unknown, date: string) => {
    const { deps } = makeDeps({ now: () => at(date), routes: { [LEDGER]: () => json(200, answer((l) => { l.open[0].chase = chase; })) } });
    return out(await whoOwesMe(call(at(date)), deps)).open?.[0]?.reminder_due ?? null;
  };
  assert.equal((await run({ days: [1] }, "2026-10-31"))?.tone, "polite");
  assert.equal(await run(null, "2026-11-20"), null);
  assert.equal((await run({ days: [3, 10] }, "2026-11-09"))?.tone, "firm");
});

test("a paid line says what was refunded", async () => {
  const { deps } = makeDeps({ now: () => at("2026-10-17"), routes: { [LEDGER]: () => json(200, answer((l) => { l.paid_recently[0].refunded = "5"; })) } });
  const result = await whoOwesMe(call(at("2026-10-17")), deps);
  assert.equal(out(result).paid_recently?.[0]?.refunded, "5");
  assert.match(textOf(result), /^Paid: 15 USDC.*, refunded 5 USDC/m);
});

test("statement: the signed message reads a client's month instead of the ledger, with its CSV and page links", async () => {
  const st = fixture("invoice.statement.res.json");
  const OWNER = signer("owed contract fixture signer: refund (holds nothing)");
  assert.equal(OWNER.address, st.recipient);
  const now = Date.parse(st.generated_at);
  const message = ledgerMessage(OWNER.address, now);
  const { deps, rec } = makeDeps({ now: () => now, routes: { "GET *": () => json(200, st) } });
  const result = await whoOwesMe(inputSchema.parse({ recipient: OWNER.address, signed_message: message, signature: OWNER.sign(message), statement: { client: "Lena", month: st.month } }), deps);
  const o = out(result);
  assert.equal(o.step, "statement");
  const url = new URL(rec.calls[0]!.url);
  assert.equal(url.pathname, "/api/v1/statements");
  assert.deepEqual(Object.fromEntries(url.searchParams), { recipient: OWNER.address, client: "Lena", month: st.month, signed_message: message, signature: OWNER.sign(message) });
  assert.deepEqual(o.statement?.totals, st.totals);
  assert.equal(o.statement?.lines.length, st.lines.length);
  assert.equal(o.statement?.csv_url, st.csv.url);
  const text = textOf(result);
  assert.match(text, /^Statement for "lena" \(as written on the invoices; unverified\), 2026-10: 4 invoices\./);
  assert.match(text, /USDC: opening balance 0, invoiced 394\.500001, cancelled or ended 0, paid 190, refunded 0, closing balance 204\.500001\./);
  assert.ok(text.includes(`Statement page: ${st.page.url}`));
});
