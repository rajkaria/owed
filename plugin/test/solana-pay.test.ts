import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import bs58 from "bs58";

import { USDC_MINT } from "../src/money.ts";
import {
  LinkError,
  MAX_LINK_CHARS,
  MAX_REFERENCES,
  buildTransferUrl,
  isSolanaAddress,
  newReference,
  parseLink,
  transferToken,
  type ParsedLink,
  type TransferRequest,
} from "../src/solana-pay.ts";

// Real mainnet keys.
const WALLET = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs"; // sol-default
const MVINES = "mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN"; // Solana Pay spec examples
const PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const REF = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e"; // contract fixtures

const HOSTS = ["owed.link", "owed-omega.vercel.app"];

function transfer(input: string, hosts = HOSTS): TransferRequest {
  const parsed = parseLink(input, hosts);
  assert.equal(parsed.kind, "transfer", input);
  return (parsed as Extract<ParsedLink, { kind: "transfer" }>).request;
}

function rejects(input: string, message: string, hosts = HOSTS) {
  assert.throws(() => parseLink(input, hosts), (e: unknown) => {
    assert.ok(e instanceof LinkError, `expected LinkError for ${JSON.stringify(input)}, got ${String(e)}`);
    assert.equal(e.message, message, JSON.stringify(input));
    return true;
  });
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
}

// --- Solana Pay spec examples, copied verbatim from https://docs.solanapay.com/spec ---

test("spec transfer example 1: SOL with label, message and memo", () => {
  // https://docs.solanapay.com/spec
  const url = "solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=1&label=Michael&message=Thanks%20for%20all%20the%20fish&memo=OrderId12345";
  const request: TransferRequest = {
    recipient: MVINES,
    amount: "1",
    references: [],
    label: "Michael",
    message: "Thanks for all the fish",
    memo: "OrderId12345",
  };
  assert.deepEqual(parseLink(url, HOSTS), { kind: "transfer", request });
  assert.equal(transferToken(request), "SOL");
  assert.equal(buildTransferUrl(request), url);
});

test("spec transfer example 2: USDC", () => {
  // https://docs.solanapay.com/spec
  const url = "solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN?amount=0.01&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const request: TransferRequest = { recipient: MVINES, amount: "0.01", splToken: USDC_MINT, references: [] };
  assert.deepEqual(parseLink(url, HOSTS), { kind: "transfer", request });
  assert.equal(transferToken(request), "USDC");
  assert.equal(buildTransferUrl(request), url);
});

test("spec transfer example 3 is malformed on the page ('&' instead of '?') and is rejected, as @solana/pay does", () => {
  // https://docs.solanapay.com/spec
  rejects("solana:mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN&label=Michael", "The recipient in this link isn't a valid Solana address.");
});

test("spec transaction request examples, plain and URL-encoded", () => {
  // https://docs.solanapay.com/spec
  assert.deepEqual(parseLink("solana:https://example.com/solana-pay", HOSTS), {
    kind: "transaction",
    link: "https://example.com/solana-pay",
  });
  // https://docs.solanapay.com/spec
  assert.deepEqual(parseLink("solana:https%3A%2F%2Fexample.com%2Fsolana-pay%3Forder%3D12345", HOSTS), {
    kind: "transaction",
    link: "https://example.com/solana-pay?order=12345",
  });
});

// --- Contract fixtures shared with the web app ---

test("contract fixture solana_pay_url parses and rebuilds byte-for-byte", () => {
  const created = fixture("create-request.res.json");
  const request: TransferRequest = {
    recipient: WALLET,
    amount: "15",
    splToken: USDC_MINT,
    references: [REF],
    label: "Raj",
    message: "dinner",
    memo: "owed:JArQ6g9JvoWr",
  };
  assert.deepEqual(parseLink(created.solana_pay_url as string, HOSTS), { kind: "transfer", request });
  assert.equal(buildTransferUrl(request), created.solana_pay_url);
  assert.equal(created.reference, REF);
  assert.deepEqual(parseLink(created.link as string, HOSTS), { kind: "owed", id: created.id });

  const raw = fixture("status-raw.req.json");
  assert.deepEqual(transfer(raw.solana_pay_url as string), {
    recipient: WALLET,
    amount: "1",
    splToken: USDC_MINT,
    references: [REF],
  });
  assert.equal(buildTransferUrl(transfer(raw.solana_pay_url as string)), raw.solana_pay_url);

  const got = fixture("get-request.res.json");
  assert.ok(isSolanaAddress((got.paid as { payer: string }).payer));
});

// --- Owed links ---

test("Owed request links and bare ids parse to kind owed", () => {
  const owed = { kind: "owed", id: "JArQ6g9JvoWr" };
  for (const input of [
    "JArQ6g9JvoWr",
    "  JArQ6g9JvoWr\n",
    "https://owed.link/r/JArQ6g9JvoWr",
    "https://owed.link/r/JArQ6g9JvoWr/",
    "https://owed.link/r/JArQ6g9JvoWr?utm_source=chat#pay",
    "https://OWED.LINK/r/JArQ6g9JvoWr",
    "HTTPS://owed.link/r/JArQ6g9JvoWr",
    "http://owed.link/r/JArQ6g9JvoWr",
    "owed.link/r/JArQ6g9JvoWr",
    "https://owed-omega.vercel.app/r/JArQ6g9JvoWr",
  ]) {
    assert.deepEqual(parseLink(input, HOSTS), owed, input);
  }
  assert.deepEqual(parseLink("https://owed.link/r/JArQ6g9JvoWr", ["https://owed.link/"]), owed);
  assert.deepEqual(parseLink("https://localhost:3000/r/JArQ6g9JvoWr", ["localhost:3000"]), owed);
});

test("Owed invoice links parse to the invoice's payment request (same id)", () => {
  const owed = { kind: "owed", id: "3ERgzxsixBMk" };
  for (const input of [
    "https://owed-omega.vercel.app/i/3ERgzxsixBMk",
    "https://owed.link/i/3ERgzxsixBMk/",
    "owed.link/i/3ERgzxsixBMk?utm_source=email",
  ]) {
    assert.deepEqual(parseLink(input, HOSTS), owed, input);
  }
  assert.throws(() => parseLink("https://owed.link/i/", HOSTS), /invalid request id/);
  assert.throws(() => parseLink("https://evil.example/i/3ERgzxsixBMk", HOSTS), /isn't an Owed link/);
  assert.throws(() => parseLink("https://owed.link/g/3ERgzxsixBMk", HOSTS), /isn't a payment request/);
});

test("bare ids must be exactly 10 base58 characters", () => {
  for (const id of ["7Gh2kQpXa", "JArQ6g9JvoWrZ", "0Gh2kQpXa9", "OGh2kQpXa9", "IGh2kQpXa9", "lGh2kQpXa9", "7Gh2kQp-a9"]) {
    rejects(id, "That isn't an Owed link or a Solana Pay link.");
  }
});

test("Owed links with a bad id, wrong path or foreign host are refused", () => {
  rejects("https://owed.link/r/7Gh2kQpXa", "That Owed link has an invalid request id.");
  rejects("https://owed.link/r/0Gh2kQpXa9", "That Owed link has an invalid request id.");
  rejects("https://owed.link/r/", "That Owed link has an invalid request id.");
  rejects("https://owed.link/r", "That Owed link has an invalid request id.");
  rejects("https://owed.link/r/JArQ6g9JvoWr/extra", "That Owed link isn't a payment request.");
  rejects("https://owed.link/", "That Owed link isn't a payment request.");
  rejects("https://owed.link/g/JArQ6g9JvoWr", "That Owed link isn't a payment request.");
  const foreign = "That web link isn't an Owed link. Owed pays links from owed.link and solana: payment links only.";
  rejects("https://evil.example/r/JArQ6g9JvoWr", foreign);
  rejects("https://owed.link.evil.example/r/JArQ6g9JvoWr", foreign);
  rejects("https://owed.link@evil.example/r/JArQ6g9JvoWr", foreign);
  rejects("https://owed.link:8443/r/JArQ6g9JvoWr", foreign);
  rejects("https://owed.link/r/JArQ6g9JvoWr", "That web link isn't a Solana Pay link. Owed pays solana: payment links.", []);
});

test("stateless /p?u= links return the inner transfer, however the inner URL is encoded", () => {
  const inner = "solana:FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs?amount=15&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e&label=Raj&message=Thanks%20for%20dinner%20%26%20drinks&memo=owed%3Aoffline";
  const expected: ParsedLink = {
    kind: "transfer",
    request: {
      recipient: WALLET,
      amount: "15",
      splToken: USDC_MINT,
      references: [REF],
      label: "Raj",
      message: "Thanks for dinner & drinks",
      memo: "owed:offline",
    },
  };
  assert.deepEqual(parseLink(`https://owed.link/p?u=${encodeURIComponent(inner)}`, HOSTS), expected);
  assert.deepEqual(parseLink(`https://owed.link/p?${new URLSearchParams({ u: inner })}`, HOSTS), expected);
  assert.deepEqual(parseLink(`https://owed-omega.vercel.app/p/?u=${encodeURIComponent(inner)}`, HOSTS), expected);
  assert.deepEqual(parseLink(`owed.link/p?u=${encodeURIComponent(inner)}`, HOSTS), expected);
});

test("stateless /p links without exactly one solana: u are refused", () => {
  const inner = encodeURIComponent(`solana:${WALLET}?amount=1`);
  const missing = "That Owed link is missing its payment details.";
  rejects("https://owed.link/p", missing);
  rejects("https://owed.link/p?u=", missing);
  rejects(`https://owed.link/p?u=${inner}&u=${inner}`, missing);
  rejects(`https://owed.link/p?u=${encodeURIComponent("https://owed.link/r/JArQ6g9JvoWr")}`, missing);
  rejects(`https://owed.link/p?u=${encodeURIComponent("bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT")}`, missing);
  rejects(`https://owed.link/p?u=${encodeURIComponent("solana:notanaddress")}`, "The recipient in this link isn't a valid Solana address.");
  assert.deepEqual(parseLink(`https://owed.link/p?u=${encodeURIComponent("solana:https://example.com/solana-pay")}`, HOSTS), {
    kind: "transaction",
    link: "https://example.com/solana-pay",
  });
});

// --- solana: transfer requests ---

test("solana: transfers: scheme is case-insensitive, fragments and unknown params are ignored", () => {
  assert.deepEqual(transfer(`SOLANA:${WALLET}?amount=2`), { recipient: WALLET, amount: "2", references: [] });
  assert.deepEqual(transfer(`Solana:${WALLET}`), { recipient: WALLET, references: [] });
  assert.deepEqual(transfer(`solana:${WALLET}?`), { recipient: WALLET, references: [] });
  assert.deepEqual(transfer(`solana:${WALLET}?amount=2&foo=bar&redirect=https%3A%2F%2Fx.example#frag`), {
    recipient: WALLET,
    amount: "2",
    references: [],
  });
  assert.deepEqual(transfer(`solana:${WALLET}#amount=999`), { recipient: WALLET, references: [] });
});

test("solana: transfers keep repeated references in order", () => {
  const refs = [REF, SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, MEMO_PROGRAM];
  const url = `solana:${WALLET}?amount=1&${refs.map((r) => `reference=${r}`).join("&")}`;
  assert.deepEqual(transfer(url).references, refs);
  assert.equal(MAX_REFERENCES, 5);
});

test("percent-encoding is decoded on parse", () => {
  const r = transfer(
    `solana:${WALLET}?label=Caf%C3%A9%20%E6%97%A5%E6%9C%AC%20%F0%9F%8D%A3&message=a%26b%3Dc%3Fd%23e%25f%2Bg%2Fh&memo=line1%0Aline2`,
  );
  assert.equal(r.label, "Café 日本 🍣");
  assert.equal(r.message, "a&b=c?d#e%f+g/h");
  assert.equal(r.memo, "line1\nline2");
});

test("'+' decodes to a space and %2B to a plus, matching @solana/pay (URLSearchParams)", () => {
  const r = transfer(`solana:${WALLET}?message=Thanks+for+dinner&memo=C%2B%2B`);
  assert.equal(r.message, "Thanks for dinner");
  assert.equal(r.memo, "C++");
});

test("empty label, message and memo are treated as absent", () => {
  assert.deepEqual(transfer(`solana:${WALLET}?amount=1&label=&message=&memo=`), {
    recipient: WALLET,
    amount: "1",
    references: [],
  });
});

test("percent-encoding is applied on build", () => {
  const url = buildTransferUrl({
    recipient: WALLET,
    amount: "1",
    references: [],
    label: "Café & Co",
    message: "a=b?c#d%e+f/g",
    memo: "owed:JArQ6g9JvoWr",
  });
  assert.equal(
    url,
    `solana:${WALLET}?amount=1&label=Caf%C3%A9%20%26%20Co&message=a%3Db%3Fc%23d%25e%2Bf%2Fg&memo=owed%3AJArQ6g9JvoWr`,
  );
});

test("unknown schemes and plain text are refused", () => {
  const unknown = "That isn't an Owed link or a Solana Pay link.";
  for (const input of [
    "bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT?amount=1",
    "ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer",
    "mailto:raj@example.com",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://owed.link/r/JArQ6g9JvoWr",
    "pay me 15 usdc",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ]) {
    rejects(input, unknown);
  }
  rejects(WALLET, "That is a wallet address, not a payment link. Ask for an Owed link or a solana: link.");
  rejects("", "Paste an Owed link, a request id or a solana: payment link.");
  rejects("   \n", "Paste an Owed link, a request id or a solana: payment link.");
  rejects(undefined as unknown as string, "Paste an Owed link, a request id or a solana: payment link.");
  rejects(`solana:${WALLET}?label=${"x".repeat(MAX_LINK_CHARS)}`, "That link is too long to be a payment link.");
});

test("bad recipients are refused", () => {
  const bad = "The recipient in this link isn't a valid Solana address.";
  for (const recipient of [
    "",
    "notanaddress",
    WALLET.slice(0, 40),
    `${WALLET}1`,
    WALLET.replace("F", "0"),
    WALLET.replace("F", "O"),
    WALLET.replace("F", "I"),
    WALLET.replace("F", "l"),
    bs58.encode(new Uint8Array(33).fill(7)),
    bs58.encode(new Uint8Array(31).fill(7)),
    `//${WALLET}`,
    encodeURIComponent(`${WALLET} `),
  ]) {
    rejects(`solana:${recipient}?amount=1`, bad);
  }
});

test("bad amounts are refused with the reason", () => {
  const prefix = "The amount in this link isn't valid. ";
  const plain = `${prefix}Amount must be a plain decimal number like 15 or 0.5.`;
  for (const amount of ["", "abc", "1e3", "-1", "+1", ".5", "5.", "01", "1,5", "0x10", "1%20", "Infinity"]) {
    rejects(`solana:${WALLET}?amount=${amount}`, plain);
  }
  rejects(`solana:${WALLET}?amount=0`, `${prefix}Amount must be more than zero.`);
  rejects(`solana:${WALLET}?amount=0.000`, `${prefix}Amount must be more than zero.`);
  rejects(`solana:${WALLET}?amount=0.0000000001`, `${prefix}SOL amounts have at most 9 decimal places.`);
  rejects(
    `solana:${WALLET}?amount=0.0000001&spl-token=${USDC_MINT}`,
    `${prefix}USDC amounts have at most 6 decimal places.`,
  );
  rejects(`solana:${WALLET}?amount=18446744073.709551616`, `${prefix}Amount is too large.`);
  rejects(`solana:${WALLET}?amount=18446744073709.551616&spl-token=${USDC_MINT}`, `${prefix}Amount is too large.`);
  // Same digits are fine as USDC: the token decides how many decimals are allowed.
  assert.equal(transfer(`solana:${WALLET}?amount=0.000001&spl-token=${USDC_MINT}`).amount, "0.000001");
  assert.equal(transfer(`solana:${WALLET}?amount=0.000000001`).amount, "0.000000001");
});

test("tokens other than USDC are refused", () => {
  for (const mint of [BONK_MINT, WSOL_MINT, "", "notamint", USDC_MINT.toLowerCase()]) {
    rejects(`solana:${WALLET}?amount=1&spl-token=${mint}`, "Owed pays USDC or SOL links only.");
  }
});

test("references must be 32-byte base58 keys, at most 5", () => {
  const bad = "A reference in this link isn't a valid 32-byte Solana key.";
  for (const ref of ["", "short", bs58.encode(new Uint8Array(33).fill(1)), bs58.encode(new Uint8Array(16).fill(1)), `${REF}0`]) {
    rejects(`solana:${WALLET}?amount=1&reference=${REF}&reference=${ref}`, bad);
  }
  const six = [REF, SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, MEMO_PROGRAM, PAYER].map((r) => `reference=${r}`).join("&");
  rejects(`solana:${WALLET}?amount=1&${six}`, "This link has more than 5 references.");
});

test("single-value params may not repeat", () => {
  rejects(`solana:${WALLET}?amount=1&amount=1000`, "This link has more than one amount.");
  rejects(`solana:${WALLET}?spl-token=${USDC_MINT}&spl-token=${USDC_MINT}`, "This link has more than one token.");
  rejects(`solana:${WALLET}?label=a&label=b`, "This link has more than one label.");
  rejects(`solana:${WALLET}?message=a&message=b`, "This link has more than one message.");
  rejects(`solana:${WALLET}?memo=a&memo=b`, "This link has more than one memo.");
});

test("transaction requests must be valid HTTPS links", () => {
  assert.deepEqual(parseLink("solana:HTTPS://example.com/solana-pay", HOSTS), {
    kind: "transaction",
    link: "HTTPS://example.com/solana-pay",
  });
  rejects("solana:http://example.com/solana-pay", "Solana Pay checkout links must use HTTPS.");
  rejects("solana:http%3A%2F%2Fexample.com%2Fsolana-pay", "Solana Pay checkout links must use HTTPS.");
  rejects("solana:https%3A%2F%2F%E0%A4%A", "That Solana Pay checkout link is malformed.");
  rejects("solana:https://", "That Solana Pay checkout link is malformed.");
});

// --- buildTransferUrl ---

const ROUND_TRIP: TransferRequest[] = [
  { recipient: WALLET, references: [] },
  { recipient: WALLET, amount: "15", splToken: USDC_MINT, references: [REF] },
  { recipient: MVINES, amount: "1", references: [], label: "Michael", message: "Thanks for all the fish", memo: "OrderId12345" },
  { recipient: WALLET, amount: "0.000001", splToken: USDC_MINT, references: [REF] },
  { recipient: WALLET, amount: "0.000000001", references: [REF] },
  { recipient: PAYER, amount: "2.5", references: [REF, SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, MEMO_PROGRAM] },
  { recipient: WALLET, amount: "18446744073709.551615", splToken: USDC_MINT, references: [] },
  { recipient: WALLET, amount: "3", splToken: USDC_MINT, references: [REF], label: "&=?#%+/;,:@$!'()*~" },
  { recipient: WALLET, amount: "12.34", splToken: USDC_MINT, references: [REF], message: "Café 日本 🍣 مرحبا" },
  { recipient: WALLET, amount: "15", splToken: USDC_MINT, references: [REF], memo: "owed:JArQ6g9JvoWr" },
  { recipient: WALLET, amount: "1", references: [], message: "line1\nline2\tend\r\n" },
  { recipient: WALLET, amount: "1", references: [], label: `"<b>Raj</b>" & 'co'` },
  { recipient: WALLET, amount: "1.50", splToken: USDC_MINT, references: [REF] },
  { recipient: WALLET, splToken: USDC_MINT, references: [REF], label: "Raj" },
  { recipient: WALLET, references: [REF, PAYER], label: "Tip jar" },
  { recipient: WALLET, amount: "4", references: [], memo: "a + b = c" },
  { recipient: WALLET, amount: "4", splToken: USDC_MINT, references: [REF], message: "x".repeat(200) },
  { recipient: WALLET, amount: "0.5", references: [], label: "💸💸", message: "🍕 split 3 ways" },
  { recipient: SYSTEM_PROGRAM, amount: "100", references: [REF] },
  { recipient: WALLET, amount: "7", splToken: USDC_MINT, references: [REF], message: "100% sure, %20 stays literal", memo: "%F0" },
];

test("buildTransferUrl output parses back to the same request (20 cases)", () => {
  assert.equal(ROUND_TRIP.length, 20);
  for (const request of ROUND_TRIP) {
    const url = buildTransferUrl(request);
    assert.ok(url.startsWith(`solana:${request.recipient}`), url);
    assert.doesNotMatch(url, /[\s"<>\\^`{|}]/, "URL has no raw spaces or unsafe characters");
    assert.deepEqual(parseLink(url, HOSTS), { kind: "transfer", request }, url);
    assert.equal(buildTransferUrl(transfer(url)), url, "build is stable after a round trip");
    // The same request wrapped in an Owed stateless link parses to the same request.
    assert.deepEqual(parseLink(`https://owed.link/p?u=${encodeURIComponent(url)}`, HOSTS), { kind: "transfer", request });
  }
});

test("buildTransferUrl emits params in spec order and omits empty texts", () => {
  assert.equal(
    buildTransferUrl({ recipient: WALLET, memo: "m", label: "l", references: [REF], amount: "1", splToken: USDC_MINT, message: "" }),
    `solana:${WALLET}?amount=1&spl-token=${USDC_MINT}&reference=${REF}&label=l&memo=m`,
  );
  assert.equal(buildTransferUrl({ recipient: WALLET, references: [], label: "", message: "", memo: "" }), `solana:${WALLET}`);
});

test("buildTransferUrl replaces lone surrogates instead of throwing", () => {
  const url = buildTransferUrl({ recipient: WALLET, references: [], label: "Raj \uD83D", message: "\uDE00x" });
  assert.equal(transfer(url).label, "Raj �");
  assert.equal(transfer(url).message, "�x");
});

test("buildTransferUrl refuses requests that would not parse", () => {
  const ok: TransferRequest = { recipient: WALLET, amount: "1", splToken: USDC_MINT, references: [REF] };
  const cases: Array<[TransferRequest, string]> = [
    [{ ...ok, recipient: "nope" }, "The recipient in this link isn't a valid Solana address."],
    [{ ...ok, splToken: BONK_MINT }, "Owed pays USDC or SOL links only."],
    [{ ...ok, amount: "0" }, "The amount in this link isn't valid. Amount must be more than zero."],
    [{ ...ok, amount: "1.0000001" }, "The amount in this link isn't valid. USDC amounts have at most 6 decimal places."],
    [{ ...ok, amount: "1e3" }, "The amount in this link isn't valid. Amount must be a plain decimal number like 15 or 0.5."],
    [{ ...ok, references: ["bad"] }, "A reference in this link isn't a valid 32-byte Solana key."],
    [{ ...ok, references: [REF, REF, REF, REF, REF, REF] }, "This link has more than 5 references."],
    [{ ...ok, references: undefined as unknown as string[] }, "A reference in this link isn't a valid 32-byte Solana key."],
    [{ ...ok, message: "x".repeat(MAX_LINK_CHARS) }, "The label, message and memo are too long for a payment link."],
  ];
  for (const [request, message] of cases) {
    assert.throws(() => buildTransferUrl(request), (e: unknown) => e instanceof LinkError && e.message === message, message);
  }
});

// --- keys ---

test("isSolanaAddress accepts base58 strings that decode to exactly 32 bytes", () => {
  for (const key of [WALLET, MVINES, PAYER, SYSTEM_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM, MEMO_PROGRAM, WSOL_MINT, BONK_MINT, USDC_MINT, REF]) {
    assert.equal(isSolanaAddress(key), true, key);
  }
  assert.equal(isSolanaAddress(bs58.encode(new Uint8Array(32).fill(255))), true);
});

test("isSolanaAddress rejects everything else", () => {
  for (const value of [
    "",
    "JArQ6g9JvoWr",
    WALLET.slice(0, 31),
    WALLET.slice(0, 40),
    `${WALLET}1`,
    ` ${WALLET}`,
    `${WALLET} `,
    WALLET.replace("F", "0"),
    bs58.encode(new Uint8Array(31).fill(9)),
    bs58.encode(new Uint8Array(33).fill(9)),
    "1".repeat(31),
    "1".repeat(33),
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "z".repeat(45),
  ]) {
    assert.equal(isSolanaAddress(value), false, JSON.stringify(value));
  }
  for (const value of [null, undefined, 42, {}, [], new Uint8Array(32)]) {
    assert.equal(isSolanaAddress(value as unknown as string), false);
  }
});

test("newReference returns 32 random bytes as base58", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const ref = newReference();
    assert.equal(isSolanaAddress(ref), true, ref);
    assert.equal(bs58.decode(ref).length, 32);
    seen.add(ref);
  }
  assert.equal(seen.size, 1000);
});

test("newReference draws its bytes from crypto.getRandomValues", (t) => {
  const getRandomValues = t.mock.method(globalThis.crypto, "getRandomValues", <T extends ArrayBufferView | null>(array: T): T => {
    if (array instanceof Uint8Array) array.fill(255);
    return array;
  });
  assert.equal(newReference(), bs58.encode(new Uint8Array(32).fill(255)));
  assert.equal(getRandomValues.mock.callCount(), 1);
  const arg = getRandomValues.mock.calls[0]?.arguments[0];
  assert.ok(arg instanceof Uint8Array && arg.length === 32);
});

test("loading the modules draws no randomness (deterministic build, fresh sandbox per call)", async (t) => {
  const getRandomValues = t.mock.method(globalThis.crypto, "getRandomValues");
  const randomUUID = t.mock.method(globalThis.crypto, "randomUUID");
  const random = t.mock.method(Math, "random");
  const now = t.mock.method(Date, "now");
  await import(`../src/money.ts?load=${process.hrtime.bigint()}`);
  await import(`../src/solana-pay.ts?load=${process.hrtime.bigint()}`);
  assert.equal(getRandomValues.mock.callCount(), 0);
  assert.equal(randomUUID.mock.callCount(), 0);
  assert.equal(random.mock.callCount(), 0);
  assert.equal(now.mock.callCount(), 0);
});
