import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { checkFixtures } from "../../contract/check.mjs";
import {
  base58Decode, base58Encode, check, fromAtomic, isPubkey, isSignature, parseSolanaPayUrl, requestIdFor, shapes, toAtomic, USDC_MINT,
} from "../../contract/shapes.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));

test("base58 round-trips real mainnet keys and rejects bad characters", () => {
  assert.deepEqual(base58Decode("11111111111111111111111111111111"), new Uint8Array(32));
  for (const key of [USDC_MINT, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs"]) {
    assert.equal(base58Decode(key).length, 32);
    assert.equal(base58Encode(base58Decode(key)), key);
    assert.ok(isPubkey(key));
  }
  assert.equal(base58Decode("0OIl"), null);
  assert.equal(isPubkey("0x3806c85df527e5336f05277ab8cc3932b9abe42a"), false);
  assert.equal(isSignature("5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2sUYv"), true);
});

test("amounts convert with bigint only", () => {
  assert.equal(toAtomic("15", 6), 15_000_000n);
  assert.equal(toAtomic("0.01", 6), 10_000n);
  assert.equal(toAtomic("4.5", 9), 4_500_000_000n);
  assert.equal(toAtomic("123456789012345678.123456", 6), 123456789012345678123456n);
  assert.throws(() => toAtomic("0.0000001", 6), /more than 6 decimal places/);
  for (const bad of ["-1", "1e3", "01", "1.", ".5", " 1", 1]) assert.throws(() => toAtomic(bad, 6));
  assert.equal(fromAtomic(10_000n, 6), "0.01");
  assert.equal(fromAtomic(15_000_000n, 6), "15");
  assert.equal(fromAtomic(1n, 9), "0.000000001");
  assert.equal(fromAtomic(0n, 6), "0");
});

test("Solana Pay URLs: transfer fields, transaction requests, garbage", () => {
  const url = "solana:FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs?amount=15&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e&label=Raj&message=dinner&memo=owed%3AJArQ6g9JvoWr";
  const parsed = parseSolanaPayUrl(url);
  assert.equal(parsed.kind, "transfer");
  assert.equal(parsed.token, "USDC");
  assert.equal(parsed.amount, "15");
  assert.deepEqual(parsed.references, ["8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e"]);
  assert.equal(parsed.memo, "owed:JArQ6g9JvoWr");
  assert.equal(parseSolanaPayUrl("solana:https%3A%2F%2Fshop.example%2Fpay").kind, "transaction");
  assert.equal(parseSolanaPayUrl("solana:https://shop.example/pay").kind, "transaction");
  assert.equal(parseSolanaPayUrl("solana:FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs").token, "SOL");
  assert.equal(parseSolanaPayUrl("solana:notakey?amount=1").ok, false);
  assert.equal(parseSolanaPayUrl("solana:FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs?amount=1,5").ok, false);
  assert.equal(parseSolanaPayUrl("bitcoin:abc").ok, false);
});

test("every fixture matches its shape", async () => {
  const results = await checkFixtures();
  assert.ok(results.length >= 9);
  for (const result of results) assert.deepEqual(result.errors, [], result.name);
});

test("shapes catch the contract breaks that matter", async () => {
  const get = await fixture("get-request.res.json");
  const errorsOf = (shape, value) => check(shapes[shape], value).errors.join("\n");

  assert.match(errorsOf("getRequestRes", { ...get, for: "pay at https://evil.example" }), /sanitized text/);
  assert.match(errorsOf("getRequestRes", { ...get, note: "bell\u0007" }), /sanitized text/);
  assert.match(errorsOf("getRequestRes", { ...get, amount: "16" }), /amount=15 differs/);
  assert.match(errorsOf("getRequestRes", { ...get, amount: 15 }), /expected string/);
  assert.match(errorsOf("getRequestRes", { ...get, amount: "0.0000001" }), /more than 6 decimal places/);
  assert.match(errorsOf("getRequestRes", { ...get, paid: null }), /status is paid but paid is null/);
  assert.match(errorsOf("getRequestRes", { ...get, status: "open" }), /status is open but paid is set/);
  assert.match(errorsOf("getRequestRes", { ...get, reference: "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9f" }), /does not carry .reference/);
  const { recipient, ...missing } = get;
  assert.match(errorsOf("getRequestRes", missing), /\.recipient: missing/);
  assert.equal(recipient.length, 44);
  assert.deepEqual(check(shapes.getRequestRes, { ...get, extra: 1 }).warnings, ["$.extra: not in the contract"]);

  const status = await fixture("status.res.json");
  const paid = { ...status.results[0] };
  delete paid.signature;
  assert.match(errorsOf("statusRes", { results: [paid] }), /signature: missing for status paid/);
  assert.match(errorsOf("statusRes", { results: [{ ...status.results[0], status: "underpaid" }] }), /underpaid but amount_paid/);
  assert.equal(errorsOf("statusRes", { results: [{ id: "1111111111", status: "not_found" }] }), "");

  const created = await fixture("create-request.res.json");
  assert.match(errorsOf("createRequestRes", { ...created, link: "https://owed.link/r/other" }), /does not end in \/r\/JArQ6g9JvoWr/);
  assert.match(errorsOf("createRequestRes", { ...created, link: "http://owed.link/r/JArQ6g9JvoWr" }), /https URL/);
  assert.match(errorsOf("errorRes", { error: { code: "boom", message: "x" } }), /not one of/);
});

test("12-char ids must hash their payment terms; 10-char ids are accepted as older random ids", async () => {
  const created = await fixture("create-request.res.json");
  assert.equal(requestIdFor({ recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", token: "USDC", amountAtomic: 15_000_000n, reference: created.reference }), created.id);
  assert.deepEqual(check(shapes.createRequestRes, created).errors, []);
  const swapped = { ...created, solana_pay_url: created.solana_pay_url.replace("amount=15&", "amount=150&") };
  assert.ok(check(shapes.createRequestRes, swapped).errors.some((e) => e.includes("is not the hash of its payment terms")));
  const legacy = { ...created, id: "7Gh2kQpXa9", link: created.link.replace(created.id, "7Gh2kQpXa9"),
    qr_url: created.qr_url.replace(created.id, "7Gh2kQpXa9"), solana_pay_url: created.solana_pay_url.replace(`owed%3A${created.id}`, "owed%3A7Gh2kQpXa9") };
  assert.deepEqual(check(shapes.createRequestRes, legacy).errors, []);
});
