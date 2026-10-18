import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  bankRailConfig,
  enterpriseConfig,
  ENTERPRISE_API_LIVE,
  ENTERPRISE_API_SANDBOX,
  liquidationOf,
  parseAutoramp,
  parseAutorampTransaction,
  parseEnterpriseEvent,
  payerRail,
  verifyEnterpriseSignature,
  virtualAccountOf,
  type Autoramp,
} from "@/lib/moonpay/enterprise";
import {
  bankAccountPrefix,
  bankDetailsGuard,
  canonicalJson,
  cashOutAccountPrefix,
  detailsHash,
  liquidationGuard,
  parseCashOutAccountMessage,
  type CashOutAccount,
  type VirtualAccount,
} from "@/lib/moonpay/accounts";
import { attribute, centsText, fiatAskOf, fiatCents, judgePayout, transactionProblem } from "@/lib/moonpay/bank";
import { isoSeconds } from "@/lib/verify-signature";
import type { ParsedTransaction } from "@/lib/validate";

// MoonPay Enterprise, pure parts: the webhook signature (against the sample MoonPay publishes), event, autoramp and
// transaction parsing, the liquidation-address guard (a wallet-signed record checked against MoonPay's answer), the
// signed bank-details guard, and bank-transfer attribution (unique amount -> paid; shared -> nothing; less ->
// underpaid; no chain credit -> nothing). Signatures are real ed25519 from throwaway keys (fixed seeds, hold nothing).

const keyFrom = (seed: string) => nacl.sign.keyPair.fromSeed(Uint8Array.from(createHash("sha256").update(seed).digest()));
const KEY = keyFrom("owed test signer: moonpay-enterprise.test.ts");
const WALLET = bs58.encode(KEY.publicKey);
const MALLORY = keyFrom("owed test signer: moonpay-enterprise.test.ts, someone else");
const signHex = (text: string, key = KEY) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), key.secretKey)).toString("hex");
const LIQUIDATION = "7UX2i7SucgLMQcfZ75s3VXmZZY4YRUyJN9X1RgfMoDUi";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OFFRAMP = "9a7b6c5d-e3f1-4a2b-8c7d-6e5f4a3b2c1d";
const ONRAMP = "d3c2b1a4-e5f6-48a9-8123-fedcba654321";
const CUSTOMER = "123e4567-e89b-12d3-a456-426614174000";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// --- configuration ---------------------------------------------------------------------------------

test("enterpriseConfig / bankRailConfig: off unless their flags and well-formed keys are set", () => {
  const keys = { MOONPAY_ENTERPRISE_API_KEY: "ent_live_0123456789abcdef", MOONPAY_ENTERPRISE_WEBHOOK_SECRET: "whsec_abcdefghijklmnop0123" };
  assert.equal(enterpriseConfig(keys), null);
  assert.equal(enterpriseConfig({ ...keys, OWED_MOONPAY_ENTERPRISE: "1", MOONPAY_ENTERPRISE_WEBHOOK_SECRET: "abcdefghijklmnop0123" }), null, "the secret is whsec_…");
  assert.equal(enterpriseConfig({ ...keys, OWED_MOONPAY_ENTERPRISE: "1", MOONPAY_ENTERPRISE_API_KEY: "short" }), null);
  assert.equal(enterpriseConfig({ ...keys, OWED_MOONPAY_ENTERPRISE: "1" })?.base, ENTERPRISE_API_LIVE);
  assert.equal(enterpriseConfig({ ...keys, OWED_MOONPAY_ENTERPRISE: "1", MOONPAY_ENTERPRISE_ENV: "sandbox" })?.base, ENTERPRISE_API_SANDBOX);
  assert.equal(bankRailConfig({ ...keys, OWED_MOONPAY_ENTERPRISE: "1" }), null, "the bank rail has its own flag");
  assert.equal(bankRailConfig({ ...keys, OWED_BANK_RAIL: "1" }), null, "and needs the Enterprise keys");
  assert.ok(bankRailConfig({ ...keys, OWED_MOONPAY_ENTERPRISE: "1", OWED_BANK_RAIL: "1" }));
});

// --- webhook signature -----------------------------------------------------------------------------

test("verifyEnterpriseSignature matches MoonPay Enterprise's published sample signature", () => {
  // https://dev.enterprise.moonpay.com/webhooks.md "Sample Signature"
  const secret = "whsec_1s/keE/2+3eQUBc+7kedMAFRoM0twsrBYPpGWbt2/csF6pbMws9RMDRU1wtRas0PwDYgDd3t7mamKhO4LBjBiQ";
  const rawBody = `{"type":"ping","timestamp":"2025-05-21T13:49:31.000000+00:00","data":{"customer_id":"3f9830ca-a98e-4020-a25b-80f21da86c97","message":{"Ping":{"id":"0196f318-b593-7803-a8f1-047d53179e06"}}}}`;
  const at = 1747835371_000;
  const input = { timestamp: "1747835371", signature: "v1=2cf8c0fc4f7485802689868f4f060ecc942d7a636ed2f14847b8bc4251f81a42", rawBody, secret };
  assert.equal(verifyEnterpriseSignature(input, at), true);
  assert.equal(verifyEnterpriseSignature({ ...input, rawBody: `${rawBody} ` }, at), false, "tampered body");
  assert.equal(verifyEnterpriseSignature({ ...input, secret: secret.slice(6) }, at), false, "the whsec_ prefix is part of the key");
  assert.equal(verifyEnterpriseSignature({ ...input, timestamp: "1747835372" }, at), false, "the timestamp is signed");
  assert.equal(verifyEnterpriseSignature(input, at + 301_000), false, "outside the 5-minute window");
  assert.equal(verifyEnterpriseSignature({ ...input, signature: input.signature.slice(3) }, at), false, "v1= is required");
  assert.equal(verifyEnterpriseSignature({ ...input, signature: null }, at), false);
  assert.equal(verifyEnterpriseSignature({ ...input, timestamp: null }, at), false);
  assert.equal(verifyEnterpriseSignature({ ...input, signature: `v1=${"0".repeat(64)} ${input.signature}` }, at), true, "one matching entry of a rotation list");
  const withDot = createHmac("sha256", secret).update(`1747835371.${rawBody}`).digest("hex");
  assert.equal(verifyEnterpriseSignature({ ...input, signature: `v1=${withDot}` }, at), false, "no '.' separator, unlike Standard Webhooks");
});

test("parseEnterpriseEvent keeps transaction and transaction_status events (an id only)", () => {
  const txId = "7d834f68-cea8-496a-8eae-bb0772365028";
  assert.deepEqual(parseEnterpriseEvent({ type: "transaction", timestamp: "x", data: { customer_id: CUSTOMER, message: { Event: { id: txId, kind: "Transaction" } } } }),
    { type: "transaction", customerId: CUSTOMER, transactionId: txId });
  assert.deepEqual(parseEnterpriseEvent({ type: "transaction_status", data: { customer_id: CUSTOMER, message: { TransactionStatus: { id: txId, status: "Pending", transaction_status: "Completed", transaction_hash: "h" } } } }),
    { type: "transaction_status", customerId: CUSTOMER, transactionId: txId });
  assert.equal(parseEnterpriseEvent({ type: "ping", data: { customer_id: CUSTOMER, message: { Ping: { id: txId } } } }), null);
  assert.equal(parseEnterpriseEvent({ type: "transaction", data: { customer_id: CUSTOMER, message: { Event: { id: txId, kind: "NewAutoramp" } } } }), null);
  assert.equal(parseEnterpriseEvent({ type: "transaction", data: { customer_id: "nope", message: { Event: { id: txId, kind: "Transaction" } } } }), null);
});

// --- autoramps -------------------------------------------------------------------------------------

function offramp(over: Record<string, unknown> = {}): Autoramp {
  return parseAutoramp({
    id: OFFRAMP, customer_id: CUSTOMER, status: "Approved", kind: "Offramp",
    source_currencies: [{ type: "Crypto", token: "USDC", blockchain: "Solana" }],
    destination_currency: { type: "Fiat", code: "EUR" },
    recipient: { type: "BankAccount", account_identifier: { type: "SEPA", iban: "DE89370400440532013000" } },
    deposit_rails: [{ type: "Crypto", chain: "Solana", address: LIQUIDATION }],
    quotes: [], source: "Standalone", is_third_party: false, fee_profile_id: CUSTOMER, batch_payout: false, created_at: "2026-10-18T10:00:00Z",
    ...over,
  })!;
}

test("liquidationOf: an Approved USDC-on-Solana offramp's single Solana deposit rail", () => {
  assert.deepEqual(liquidationOf(offramp()), { ok: true, address: LIQUIDATION, currency: "EUR", rail: "SEPA" });
  const why = (a: Autoramp) => {
    const l = liquidationOf(a);
    assert.equal(l.ok, false);
    return l.ok ? "" : l.problem;
  };
  assert.match(why(offramp({ status: "Authorized" })), /not Approved/);
  assert.match(why(offramp({ kind: "Onramp" })), /not an offramp/);
  assert.match(why(offramp({ source_currencies: [{ type: "Crypto", token: "USDC", blockchain: "Ethereum" }] })), /USDC on Solana/);
  assert.match(why(offramp({ destination_currency: { type: "Fiat", code: "BRL" } })), /EUR, USD or GBP/);
  assert.match(why(offramp({ deposit_rails: [] })), /no Solana deposit address/);
  assert.match(why(offramp({ deposit_rails: [{ type: "Crypto", chain: "Solana", address: LIQUIDATION }, { type: "Crypto", chain: "Solana", address: OTHER }] })), /more than one/);
  assert.match(why(offramp({ deposit_rails: [{ type: "Crypto", chain: "Solana", address: "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe" }] })), /isn't a Solana address/);
  assert.match(why(offramp({ recipient: { type: "Wallet", blockchain: "Solana", address: OTHER } })), /bank account/);
  assert.equal(parseAutoramp({ id: "nope" }), null);
});

function onramp(over: Record<string, unknown> = {}): Autoramp {
  return parseAutoramp({
    id: ONRAMP, customer_id: CUSTOMER, status: "Approved", kind: "Onramp",
    source_currencies: [{ type: "Fiat", code: "EUR" }],
    destination_currency: { type: "Crypto", token: "USDC", blockchain: "Solana" },
    recipient: { type: "Wallet", blockchain: "Solana", address: WALLET },
    deposit_rails: [{ type: "SEPA", iban: "DE89370400440532013000", bic: "COBADEFFXXX", beneficiary_name: "Jane Doe", name: "Iron Bank", address: "10 Downing Street", phone: "+44" }],
    ...over,
  })!;
}

test("virtualAccountOf: the payer-facing details of an Approved onramp to this wallet, nothing else", () => {
  const va = virtualAccountOf(onramp(), WALLET);
  assert.deepEqual(va, { ok: true, currency: "EUR", rails: [{ type: "SEPA", iban: "DE89370400440532013000", bic: "COBADEFFXXX", account_holder: "Jane Doe", bank_name: "Iron Bank" }] });
  assert.equal(JSON.stringify(va).includes("Downing"), false, "the bank's address and phone are not kept");
  assert.equal(virtualAccountOf(onramp(), OTHER).ok, false, "another wallet's route");
  assert.equal(virtualAccountOf(onramp({ status: "Authorized" }), WALLET).ok, false);
  assert.equal(virtualAccountOf(onramp({ destination_currency: { type: "Crypto", token: "USDC", blockchain: "Base" } }), WALLET).ok, false);
  assert.equal(virtualAccountOf(onramp({ deposit_rails: [{ type: "ACH", routing_number: "021000021", account_number: "123456789" }] }), WALLET).ok, false, "a USD rail on a EUR account");
  const usd = virtualAccountOf(onramp({
    source_currencies: [{ type: "Fiat", code: "USD" }],
    deposit_rails: [
      { type: "ACH", routing_number: "021000021", account_number: "123456789", bank_name: "JPMorgan Chase Bank", bank_address: "x", recipient_name: "Jane Doe", recipient_address: "y" },
      { type: "Wire", routing_number: "021000021", account_number: "987654321", bank_name: "JPMorgan Chase Bank", bank_address: "x", recipient_name: "Jane Doe", recipient_address: "y" },
    ],
  }), WALLET);
  assert.equal(usd.ok && usd.rails.map((r) => r.type).join(","), "ACH,Wire");
  const gbp = virtualAccountOf(onramp({ source_currencies: [{ type: "Fiat", code: "GBP" }], deposit_rails: [{ type: "FPS", sort_code: "20-00-00", account_number: "55779911", beneficiary_name: "Jane Doe" }] }), WALLET);
  assert.equal(gbp.ok && gbp.rails[0].type, "FPS");
  assert.equal(payerRail({ type: "SEPA", iban: "not an iban" }), null);
  assert.equal(payerRail({ type: "CHAPS", sort_code: "20-00-00", account_number: "123" }), null);
});

// --- the signed records ----------------------------------------------------------------------------

const NOW = Date.parse("2026-10-18T10:00:00Z");
function account(over: Partial<CashOutAccount> = {}, key = KEY): CashOutAccount {
  const message = `${cashOutAccountPrefix(OFFRAMP, LIQUIDATION, WALLET)} at ${isoSeconds(NOW)}`;
  return {
    id: OFFRAMP, wallet: WALLET, providerCustomerId: CUSTOMER, liquidationAddress: LIQUIDATION, currency: "EUR", payoutRail: "SEPA",
    signedMessage: message, signature: signHex(message, key), status: "active", createdAt: "2026-10-18T10:00:00Z", ...over,
  };
}

test("the cash-out account message names the route, the address and the wallet, and parses back", () => {
  const m = `${cashOutAccountPrefix(OFFRAMP, LIQUIDATION, WALLET)} at 2026-10-18T10:00:00Z`;
  assert.ok(m.length <= 200, "fits PayBox's 200-character signed message");
  assert.deepEqual(parseCashOutAccountMessage(m), { autorampId: OFFRAMP, liquidation: LIQUIDATION, wallet: WALLET, atMs: NOW });
  assert.equal(parseCashOutAccountMessage(m.replace(" to ", " for ")), null);
  assert.equal(parseCashOutAccountMessage(`${m} extra`), null);
});

test("liquidationGuard: the wallet's own signed record and MoonPay's answer read now must name the same address", () => {
  assert.equal(liquidationGuard(account(), offramp(), WALLET), null);
  assert.match(liquidationGuard(account(), offramp({ deposit_rails: [{ type: "Crypto", chain: "Solana", address: OTHER }] }), WALLET)!, /isn't the one this wallet signed for/);
  assert.match(liquidationGuard(account({ liquidationAddress: OTHER }), offramp({ deposit_rails: [{ type: "Crypto", chain: "Solana", address: OTHER }] }), WALLET)!, /doesn't match the message/, "a record edited after signing");
  assert.match(liquidationGuard(account({}, MALLORY), offramp(), WALLET)!, /isn't signed by this wallet/);
  assert.match(liquidationGuard(account(), offramp(), OTHER)!, /different wallet/);
  assert.match(liquidationGuard(account({ status: "closed" }), offramp(), WALLET)!, /closed/);
  assert.match(liquidationGuard(account(), null, WALLET)!, /no longer knows/);
  assert.match(liquidationGuard(account(), offramp({ customer_id: "00000000-0000-4000-8000-000000000000" }), WALLET)!, /different cash-out route/);
  assert.match(liquidationGuard(account(), offramp({ status: "Cancelled" }), WALLET)!, /not Approved/);
});

function virtualAccount(over: Partial<VirtualAccount> = {}, key = KEY): VirtualAccount {
  const details = { currency: "EUR" as const, rails: [{ type: "SEPA" as const, iban: "DE89370400440532013000", bic: "COBADEFFXXX", account_holder: "Jane Doe", bank_name: "Iron Bank" }] };
  const hash = detailsHash(details);
  const message = `${bankAccountPrefix(ONRAMP, hash, WALLET)} at ${isoSeconds(NOW)}`;
  return {
    id: ONRAMP, wallet: WALLET, providerCustomerId: CUSTOMER, currency: "EUR", rails: ["SEPA"], details, detailsHash: hash,
    signedMessage: message, signature: signHex(message, key), status: "active", createdAt: "2026-10-18T10:00:00Z", ...over,
  };
}

test("bankDetailsGuard: shown only when the recipient's wallet signed exactly these details", () => {
  assert.equal(bankDetailsGuard(virtualAccount()), null);
  const swapped = virtualAccount();
  swapped.details = { ...swapped.details, rails: [{ ...swapped.details.rails[0], iban: "GB33BUKB20201555555555" } as never] };
  assert.match(bankDetailsGuard(swapped)!, /changed after the recipient signed/);
  assert.match(bankDetailsGuard(virtualAccount({}, MALLORY))!, /aren't signed by the recipient/);
  assert.match(bankDetailsGuard(virtualAccount({ status: "closed" }))!, /closed/);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), `{"a":[{"c":3,"d":2}],"b":1}`);
  assert.match(detailsHash(virtualAccount().details), /^[0-9a-f]{16}$/);
});

// --- bank transfers --------------------------------------------------------------------------------

test("fiatAskOf: EUR/GBP quotes, or a plain USDC amount as USD, in whole cents", () => {
  assert.deepEqual(fiatAskOf({ token: "USDC", chain: "solana", amountAtomic: 108_000_000n, fiat: { currency: "EUR", amount: "100" } }), { currency: "EUR", cents: 10_000n });
  assert.deepEqual(fiatAskOf({ token: "USDC", amountAtomic: 25_500_000n }), { currency: "USD", cents: 2_550n });
  assert.equal(fiatAskOf({ token: "USDC", amountAtomic: 25_123_456n }), null, "sub-cent USD can't be sent by bank");
  assert.equal(fiatAskOf({ token: "USDC", amountAtomic: 1n, fiat: { currency: "INR", amount: "1200" } }), null, "no INR virtual accounts");
  assert.equal(fiatAskOf({ token: "SOL", amountAtomic: 1n }), null);
  assert.equal(fiatAskOf({ token: "USDC", chain: "base", amountAtomic: 1_000_000n }), null);
  assert.equal(fiatCents("100.5"), 10_050n);
  assert.equal(fiatCents("100.555"), null);
  assert.equal(fiatCents("0"), null);
  assert.equal(centsText(10_050n), "100.50");
  assert.equal(centsText(10_000n), "100");
});

test("attribute: one open invoice with the amount -> paid; two -> nothing; less than the only one -> underpaid", () => {
  const eur = (id: string, cents: bigint) => ({ id, ask: { currency: "EUR" as const, cents } });
  const received = { currency: "EUR" as const, cents: 10_000n };
  assert.deepEqual(attribute(received, [eur("A", 10_000n), eur("B", 5_000n)]), { kind: "paid", requestId: "A" });
  assert.deepEqual(attribute(received, [eur("A", 10_000n), eur("B", 10_000n)]), { kind: "ambiguous", requestIds: ["A", "B"] });
  assert.deepEqual(attribute({ currency: "EUR", cents: 9_000n }, [eur("A", 10_000n)]), { kind: "underpaid", requestId: "A" });
  assert.deepEqual(attribute({ currency: "EUR", cents: 9_000n }, [eur("A", 10_000n), eur("B", 12_000n)]), { kind: "unmatched" }, "less than which? nothing");
  assert.deepEqual(attribute({ currency: "EUR", cents: 11_000n }, [eur("A", 10_000n)]), { kind: "unmatched" }, "more than the invoice: nothing automatic");
  assert.deepEqual(attribute(received, [{ id: "U", ask: { currency: "USD", cents: 10_000n } }]), { kind: "unmatched" }, "another currency never matches");
  assert.deepEqual(attribute(received, [{ id: "N", ask: null }]), { kind: "unmatched" });
});

function payoutTx({ signature = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2s111", owner = WALLET, credit = 107_000_000n, err = null as unknown, blockTime = 1_792_300_100 } = {}): ParsedTransaction {
  const keys = [LIQUIDATION, "Bpo5quLAxFJj2eeQ9DrBGLEK69WwMD9k8ZbUF1aSeby9", "2YXyjxcV8FqSeZ8iRqZoNUnxAvfuX49d7VmzTmySgv1x", USDC];
  return {
    slot: 1, blockTime,
    meta: {
      err, preBalances: keys.map(() => 1), postBalances: keys.map(() => 1), innerInstructions: [],
      preTokenBalances: [{ accountIndex: 2, mint: USDC, owner, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC, owner, uiTokenAmount: { amount: String(credit) } }],
    },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys.map((pubkey, i) => ({ pubkey, signer: i === 0, writable: i < 3 })),
        instructions: [{ program: "spl-token", parsed: { type: "transferChecked", info: { source: keys[1], mint: USDC, destination: keys[2], authority: LIQUIDATION, tokenAmount: { amount: String(credit) } } } }],
      },
    },
  };
}
const SIG = "5h6xBEauJ3PK6SWCZ1PGjBvj8vDdWG3KpwATGy1ARAXFSDwt8GFXM7W5Ncn16wmqokgpiKRLuS83KUxyZyv2s111";

test("judgePayout: only a confirmed USDC credit to the recipient counts; not on chain yet -> keep waiting", () => {
  const v = judgePayout(payoutTx(), SIG, WALLET, 1_792_300_000);
  assert.equal(v.state, "credited");
  if (v.state === "credited") assert.equal(v.credit.amountAtomic, 107_000_000n);
  assert.equal(judgePayout(null, SIG, WALLET, null).state, "sent", "MoonPay's word without the chain marks nothing");
  assert.equal(judgePayout(payoutTx({ owner: OTHER }), SIG, WALLET, null).state, "mismatch");
  assert.equal(judgePayout(payoutTx({ err: { InstructionError: [0, "x"] } }), SIG, WALLET, null).state, "mismatch");
  assert.equal(judgePayout(payoutTx({ signature: `${SIG.slice(0, -1)}2` }), SIG, WALLET, null).state, "mismatch");
  assert.equal(judgePayout(payoutTx({ blockTime: 1_792_200_000 }), SIG, WALLET, 1_792_300_000).state, "mismatch", "older than the bank transfer");
});

test("transactionProblem: MoonPay's transaction must be this account's, to this wallet, in its currency, USDC on Solana", () => {
  const va = virtualAccount();
  const base = {
    id: "7d834f68-cea8-496a-8eae-bb0772365028", customer_id: CUSTOMER, autoramp_id: ONRAMP, status: "Completed",
    source_amount: { amount: "100", currency: { type: "Fiat", code: "EUR" } },
    destination_amount: { amount: "107", currency: { type: "Crypto", token: "USDC", blockchain: "Solana" } },
    recipient: { type: "Wallet", blockchain: "Solana", address: WALLET },
    payout_crypto_transaction: { transaction_hash: SIG }, created_at: "2026-10-18T10:00:00Z", fee: "0", exchange_rate: "1.07", fee_settlement: "deductedImmediately", is_third_party: false, kind: "Onramp", state: "Payout",
  };
  const t = (over: Record<string, unknown> = {}) => parseAutorampTransaction({ ...base, ...over })!;
  assert.equal(t().payoutHash, SIG);
  assert.equal(transactionProblem(t(), va), null);
  assert.match(transactionProblem(t({ autoramp_id: OFFRAMP }), va)!, /different route/);
  assert.match(transactionProblem(t({ customer_id: "00000000-0000-4000-8000-000000000000" }), va)!, /different MoonPay customer/);
  assert.match(transactionProblem(t({ recipient: { type: "Wallet", blockchain: "Solana", address: OTHER } }), va)!, /different wallet/);
  assert.match(transactionProblem(t({ source_amount: { amount: "100", currency: { type: "Fiat", code: "USD" } } }), va)!, /wasn't in EUR/);
  assert.match(transactionProblem(t({ destination_amount: { amount: "107", currency: { type: "Crypto", token: "USDT", blockchain: "Solana" } } }), va)!, /USDC on Solana/);
  assert.match(transactionProblem(t({ source_amount: { amount: "100.001", currency: { type: "Fiat", code: "EUR" } } }), va)!, /whole number of cents/);
  assert.equal(parseAutorampTransaction({ ...base, status: "Unknown" }), null);
});
