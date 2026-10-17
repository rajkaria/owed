import { test } from "node:test";
import assert from "node:assert/strict";
import { askForMoney, inputSchema, outputSchema, type AskOutput } from "../src/tools/ask_for_money.ts";
import { BASE, fixture, html, json, makeDeps, RECIPIENT, REFERENCE, textOf, USDC_MINT, usingReal } from "./helpers.ts";

const created = fixture("create-request.res.json");
const input = (extra: Record<string, unknown> = {}) => inputSchema.parse({
  recipient: RECIPIENT, amount: "15", payer_name: "Priya", for: "dinner", note: "Thanks for coming!", requester_name: "Raj", ...extra,
});
const ok = { "POST /api/v1/requests": () => json(201, created) };

function structured(result: Awaited<ReturnType<typeof askForMoney>>): AskOutput {
  assert.ok(!("isError" in result) || !result.isError, `unexpected refusal: ${textOf(result)}`);
  const out = (result as { structuredContent: AskOutput }).structuredContent;
  outputSchema.parse(out);
  return out;
}

test("hosted: creates the request through the API and returns the SPEC text and share text", async () => {
  const { deps, rec } = makeDeps({ routes: ok });
  const result = await askForMoney(input(), deps);
  const out = structured(result);
  assert.deepEqual(out, {
    id: "7Gh2kQpXa9", mode: "hosted", link: "https://owed.link/r/7Gh2kQpXa9",
    solana_pay_url: created.solana_pay_url, qr_url: created.qr_url, reference: created.reference,
    recipient: RECIPIENT, amount: "15", token: "USDC", payer_name: "Priya", for: "dinner",
    share_text: `Hey Priya, it's Raj. Your share for "dinner" is 15 USDC. Pay with any Solana wallet here: https://owed.link/r/7Gh2kQpXa9`,
    status: "open",
  });
  assert.equal(textOf(result).split("\n")[0], 'Request ready: 15 USDC from Priya for "dinner". Send this link: https://owed.link/r/7Gh2kQpXa9');
  assert.match(textOf(result), /Message to send: Hey Priya/);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0]!.url, `${BASE}/api/v1/requests`);
  assert.deepEqual(rec.calls[0]!.body, fixture("create-request.req.json"));
});

test("token defaults to USDC; amounts are normalised through atomic units", async () => {
  assert.equal(inputSchema.parse({ recipient: RECIPIENT, amount: "1" }).token, "USDC");
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/requests": () => "network_error" } });
  const out = structured(await askForMoney(inputSchema.parse({ recipient: RECIPIENT, amount: "2.500", token: "SOL" }), deps));
  assert.equal(out.amount, "2.5");
  assert.equal(out.token, "SOL");
  assert.equal((rec.calls[0]!.body as { amount: string }).amount, "2.5");
});

test("untrusted text is cleaned before it is sent or shown", async () => {
  const { deps, rec } = makeDeps({ routes: { "POST /api/v1/requests": () => "network_error" } });
  const result = await askForMoney(input({ for: "dinner\u0000 at https://evil.example", payer_name: `Priya${String.fromCodePoint(0x202e)}`, note: "see www.x.io" }), deps);
  const out = structured(result);
  assert.equal(out.for, "dinner at [link removed]");
  assert.equal(out.payer_name, "Priya");
  const body = rec.calls[0]!.body as Record<string, string>;
  assert.equal(body.for, "dinner at [link removed]");
  assert.equal(body.note, "see [link removed]");
  assert.doesNotMatch(textOf(result), /evil|www\.x/);
});

test("text that cleans to nothing is dropped", async () => {
  const { deps, rec } = makeDeps({ routes: ok });
  await askForMoney(input({ for: "https://only-a-link.com", payer_name: String.fromCodePoint(0x200b) }), deps);
  const body = rec.calls[0]!.body as Record<string, string>;
  assert.equal("payer_name" in body, false);
  assert.equal(body.for, "[link removed]");
});

for (const [name, route] of Object.entries({
  "the API is unreachable": () => "network_error" as const,
  "the API answers 503": () => json(503, { error: { code: "upstream_unavailable", message: "db" } }),
  "the API route is missing (HTML 404)": () => html(404),
  "the API answers off-contract": () => json(201, { id: 1 }),
})) {
  test(`offline: ${name} → stateless /p?u= link built in the plugin`, async () => {
    const { deps } = makeDeps({ routes: { "POST /api/v1/requests": route } });
    const result = await askForMoney(input(), deps);
    const out = structured(result);
    assert.equal(out.mode, "offline");
    assert.equal(out.id, null);
    assert.equal(out.qr_url, null);
    assert.equal(out.status, "open");
    assert.ok(out.link.startsWith(`${BASE}/p?u=`));
    assert.equal(decodeURIComponent(out.link.slice(`${BASE}/p?u=`.length)), out.solana_pay_url);
    const parsed = deps.parseLink(out.solana_pay_url, []);
    assert.equal(parsed.kind, "transfer");
    if (parsed.kind !== "transfer") return;
    assert.equal(parsed.request.recipient, RECIPIENT);
    assert.equal(parsed.request.amount, "15");
    assert.equal(parsed.request.splToken, USDC_MINT);
    assert.deepEqual(parsed.request.references, [out.reference]);
    if (!usingReal.newReference) assert.equal(out.reference, REFERENCE);
    assert.equal(deps.isSolanaAddress(out.reference), true);
    assert.equal(parsed.request.label, "Raj");
    assert.equal(parsed.request.message, "dinner");
    // The /p link parses back to the same transfer, so check_payments and pay_link accept it.
    const viaPage = deps.parseLink(out.link, ["owed-omega.vercel.app"]);
    assert.deepEqual(viaPage, parsed);
    assert.match(out.share_text, /Pay with any Solana wallet here: https:\/\/owed-omega\.vercel\.app\/p\?u=solana%3A/);
    assert.match(textOf(result), /self-contained link/);
  });
}

test("offline: API timeout falls back within the 4 s budget", async () => {
  const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => "hang" } });
  const started = Date.now();
  const out = structured(await askForMoney(input(), deps));
  assert.equal(out.mode, "offline");
  assert.ok(Date.now() - started < 5000);
});

test("offline: SOL links carry no spl-token and use the configured base URL", async () => {
  const { deps } = makeDeps({ env: { OWED_BASE_URL: "https://owed.link" }, routes: { "POST *": () => "network_error" } });
  const out = structured(await askForMoney(inputSchema.parse({ recipient: RECIPIENT, amount: "0.25", token: "SOL" }), deps));
  assert.ok(out.link.startsWith("https://owed.link/p?u="));
  const parsed = deps.parseLink(out.solana_pay_url, []);
  assert.ok(parsed.kind === "transfer" && parsed.request.splToken === undefined && parsed.request.amount === "0.25");
});

test("API refusals are not turned into offline links", async () => {
  const cases = [
    [429, "rate_limited", /limiting new requests/],
    [400, "invalid_input", /Owed rejected the request: bad amount/],
    [403, "blocked", /can't create a request for this recipient/],
  ] as const;
  for (const [status, code, expected] of cases) {
    const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => json(status, { error: { code, message: "bad amount" } }) } });
    const result = await askForMoney(input(), deps);
    assert.equal((result as { isError?: boolean }).isError, true, code);
    assert.match(textOf(result), expected);
  }
});

test("refuses a hosted link that pays someone else or a different amount", async () => {
  const other = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const tampered = [
    { ...created, solana_pay_url: created.solana_pay_url.replace(RECIPIENT, other) },
    { ...created, solana_pay_url: created.solana_pay_url.replace("amount=15", "amount=150") },
    { ...created, solana_pay_url: created.solana_pay_url.replace(`&spl-token=${USDC_MINT}`, "") },
    { ...created, reference: other },
    { ...created, solana_pay_url: "solana:https%3A%2F%2Fevil.example%2Fcheckout" },
  ];
  for (const body of tampered) {
    const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, body) } });
    const result = await askForMoney(input(), deps);
    assert.equal((result as { isError?: boolean }).isError, true, JSON.stringify(body).slice(0, 80));
    assert.match(textOf(result), /doesn't match this request/);
  }
});

test("accepts a hosted link on a domain the plugin doesn't know yet (domain switch)", async () => {
  const moved = { ...created, link: "https://getowed.xyz/r/7Gh2kQpXa9", qr_url: "https://getowed.xyz/api/qr/7Gh2kQpXa9.png" };
  const { deps } = makeDeps({ routes: { "POST /api/v1/requests": () => json(201, moved) } });
  assert.equal(structured(await askForMoney(input(), deps)).link, "https://getowed.xyz/r/7Gh2kQpXa9");
});

test("rejects bad recipients, amounts and misconfiguration", async () => {
  const { deps } = makeDeps({ routes: ok });
  // 44 base58 chars that don't decode to 32 bytes.
  const bad = await askForMoney(input({ recipient: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz" }), deps);
  assert.match(textOf(bad), /recipient must be a Solana wallet address/);
  for (const amount of ["0", "0.0000001"]) {
    const r = await askForMoney(input({ amount }), deps);
    assert.equal((r as { isError?: boolean }).isError, true, amount);
    assert.match(textOf(r), new RegExp(`^${amount.replace(".", "\\.")} USDC isn't a valid amount`));
  }
  const { deps: misconfigured } = makeDeps({ env: { OWED_BASE_URL: "http://owed.link" }, routes: ok });
  assert.match(textOf(await askForMoney(input(), misconfigured)), /OWED_BASE_URL must be an https origin/);
});

test("input schema is strict and bounded", () => {
  const base = { recipient: RECIPIENT, amount: "15" };
  const rejects = (v: object) => assert.equal(inputSchema.safeParse(v).success, false, JSON.stringify(v));
  rejects({ ...base, extra: true });
  for (const amount of ["1e5", "-1", "01", "1.", ".5", "1,5", " 1", "", "1".repeat(41)]) rejects({ ...base, amount });
  rejects({ ...base, token: "BONK" });
  rejects({ ...base, payer_name: "x".repeat(41) });
  rejects({ ...base, for: "x".repeat(81) });
  rejects({ ...base, note: "x".repeat(141) });
  rejects({ ...base, requester_name: "x".repeat(41) });
  rejects({ ...base, payer_name: "" });
  rejects({ ...base, recipient: "0x3806c85df527e5336f05277ab8cc3932b9abe42a" });
  rejects({ amount: "15" });
  assert.equal(inputSchema.safeParse({ ...base, for: "x".repeat(80), note: "y".repeat(140) }).success, true);
});
