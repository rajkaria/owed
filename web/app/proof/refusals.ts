// /proof "What Owed refuses" and "Paid on": static rows, each one taken from docs/FACTS.md (the line is cited
// next to it, as of main 117bc43). Nothing here is requester-written, and nothing is claimed beyond where FACTS
// says it was seen: "unit test" rows were never observed on production. `facts` holds a phrase copied from that
// FACTS line; test/refusals.test.ts checks it still appears there, so a row can't outlive its fact.

export type Observed = "production" | "mainnet" | "unit test" | "PayBox portal";

export interface Evidence {
  label: string;
  href: string;
}

export interface Refusal {
  scenario: string;
  outcome: string;
  observed: Observed[];
  evidence: Evidence[];
  /** A phrase copied verbatim from the FACTS.md line this row comes from. */
  facts: string;
}

export interface PaidRail {
  rail: string;
  via: string;
  requestId: string;
  amount: string;
  tx: Evidence;
  facts: string;
}

// Test files are linked at a commit on main, so line anchors keep pointing at the test they name.
const MAIN = "https://github.com/rajkaria/owed/blob/117bc43503e368916d7586050d3d9d6285a11315";
const SOLSCAN = "https://solscan.io/tx/";

export const REFUSALS: readonly Refusal[] = [
  // FACTS.md line 22 (cancel_request on production, request 36YnZHG72CKv).
  {
    scenario: "Someone tries to pay a request its recipient cancelled",
    outcome:
      "pay_link refuses (“This request was cancelled by the requester.”), the x402 endpoint answers 409, and the pay page shows Cancelled with no QR code or wallet link.",
    observed: ["production"],
    evidence: [{ label: "Request 36YnZHG72CKv", href: "/r/36YnZHG72CKv" }],
    facts: "`/x/36YnZHG72CKv` → 409",
  },
  // FACTS.md line 22 (the cancel is signed by the recipient; the same signature replayed).
  {
    scenario: "A recipient’s cancel signature is sent a second time",
    outcome: "Refused with 400 “already used”. Only the recipient’s own fresh signature cancels a request.",
    observed: ["production"],
    evidence: [
      { label: "Request 36YnZHG72CKv", href: "/r/36YnZHG72CKv" },
      { label: "Test", href: `${MAIN}/web/test/cancel-db.test.ts#L359` },
    ],
    facts: "the same signature replayed → 400 \"already used\"",
  },
  // FACTS.md line 53 (full signatures read from mainnet: getSignaturesForAddress on the team wallet's USDC account).
  {
    scenario: "Three real USDC transfers reach the team wallet without naming a request’s reference",
    outcome: "No Owed request counts them as paid. A payment must carry the request’s reference to settle it.",
    observed: ["mainnet"],
    evidence: [
      { label: "1 USDC", href: `${SOLSCAN}5LPHMNke5nYHpnBiR65JUF9Bhp5WQqSbWaB38dwDBtZdevKU6y4abqdM53oajiVnCyrCEV42hc8Bani28XnqSuHA` },
      { label: "0.01 USDC", href: `${SOLSCAN}5w8NvDDoTWKEWjVABR78bwTXbbiutvvgXqe9WAegotZq2s4awqXf5oHKLg8zpnUZ9aE2pCxA3s9e4zASndGS5cTp` },
      { label: "0.01 USDC", href: `${SOLSCAN}3V3GyHymd4d1wT8RDmoSLcXLo5BvRyCNrqaoT6tMxyMX81TEc41rqhAvbCpcXbLYMGaPB641obfxu4kV6tgUSyXW` },
    ],
    facts: "carry no Solana Pay reference and no memo, so no Owed request counts them as paid",
  },
  // FACTS.md line 33 (verified payee on production); the TXT record itself is FACTS.md line 12.
  {
    scenario: "A request claims a domain that doesn’t publish its wallet",
    outcome: "The server answers 400 and names the DNS TXT record to add. No request is created, so no verified badge.",
    observed: ["production"],
    evidence: [
      { label: "_owed.getowed.xyz TXT", href: "https://dns.google/resolve?name=_owed.getowed.xyz&type=TXT" },
      { label: "Test", href: `${MAIN}/web/test/payee-db.test.ts#L120` },
    ],
    facts: "The same domain for a wallet it doesn't publish → 400 naming the TXT record to add",
  },
  // FACTS.md line 14 (QA-02, portal Test console, build bbabd54).
  {
    scenario: "A lookalike domain, getowed.xyz.paybox-support.com",
    outcome:
      "verify_payee says not verified, and warns that it looks like PayBox and like Owed but is neither, and only starts with “getowed.xyz”.",
    observed: ["PayBox portal"],
    evidence: [{ label: "Test", href: `${MAIN}/plugin/test/payee.test.ts#L356` }],
    facts: "`verify_payee {domain: getowed.xyz.paybox-support.com}` → not verified",
  },
  // FACTS.md line 23 (who_owes_me CSV on production).
  {
    scenario: "A who_owes_me CSV link is edited, or used after 10 minutes",
    outcome: "An edited recipient is refused with 403; the link expires after 10 minutes with 410.",
    observed: ["production"],
    evidence: [{ label: "Test", href: `${MAIN}/web/test/schedules.test.ts#L134` }],
    facts: "refused an edited recipient (403) and expired after 10 minutes (410)",
  },
  // FACTS.md lines 60-61 (request ids commit to the payment terms). Unit test only: never claimed on production.
  {
    scenario: "The server swaps the recipient, amount or reference behind a shared link",
    outcome:
      "pay_link recomputes the request id from the terms it was given and refuses on a mismatch, so a swapped link proposes nothing.",
    observed: ["unit test"],
    evidence: [{ label: "Test", href: `${MAIN}/plugin/test/pay_link.test.ts#L179` }],
    facts: "a server returning an internally consistent swapped recipient, amount or reference is refused",
  },
  // FACTS.md line 64 (portal, build 9c93ee8); the rule is FACTS.md line 62.
  {
    scenario: "An older Owed link whose id can’t be checked against its terms",
    outcome: "pay_link refuses it before proposing anything.",
    observed: ["PayBox portal"],
    evidence: [{ label: "Test", href: `${MAIN}/plugin/test/pay_link.test.ts#L205` }],
    facts: "`pay_link` on the older link `1RRer81ufk` → refused",
  },
  // FACTS.md line 71 (portal Test console, build ed9623b).
  {
    scenario: "A request that pays the payer’s own wallet",
    outcome: "pay_link refuses: “This request pays your own wallet, so there is nothing to send.”",
    observed: ["PayBox portal"],
    evidence: [{ label: "Test", href: `${MAIN}/plugin/test/pay_link.test.ts#L214` }],
    facts: "This request pays your own wallet, so there is nothing to send.",
  },
  // FACTS.md line 19 (sanctions screen, main 79a06eb). Shown by the test, not observed on production.
  {
    scenario: "A request to an address on the U.S. Treasury’s OFAC SDN list",
    outcome: "The plugin refuses with a check that needs no network; every create route on the server answers 403 blocked.",
    observed: ["unit test"],
    evidence: [{ label: "Test", href: `${MAIN}/web/test/sanctions.test.ts#L26` }],
    facts: "the server answers 403 `blocked`",
  },
  // FACTS.md line 42 (every decoded proposal) and line 50 (the mainnet wallet-QR payment's instructions).
  {
    scenario: "Any fee, or any Owed account, inside a payment",
    outcome:
      "None. A proposal holds a memo and one transfer to the recipient, plus an account create the payer pays for when the recipient has no USDC account yet.",
    observed: ["production", "mainnet"],
    evidence: [
      {
        label: "Mainnet payment",
        href: `${SOLSCAN}mBefU4x5vN7nfLZhPkJbsEsmXuTaWYZrkGrBiHBEUXJE7BySYXqNYDYJ7ePmRETCBWoBYGNsWDeJosVHGmuf3i9`,
      },
    ],
    facts: "No instruction in any decoded proposal sends anything to Owed.",
  },
];

export const PAID_ON: readonly PaidRail[] = [
  // FACTS.md line 50.
  {
    rail: "Solana Pay QR",
    via: "Scanned with Phantom",
    requestId: "qNaosx73zzt3",
    amount: "0.01 USDC",
    tx: {
      label: "Solscan",
      href: `${SOLSCAN}mBefU4x5vN7nfLZhPkJbsEsmXuTaWYZrkGrBiHBEUXJE7BySYXqNYDYJ7ePmRETCBWoBYGNsWDeJosVHGmuf3i9`,
    },
    facts: "request `qNaosx73zzt3`, 0.01 USDC to the team wallet",
  },
  // FACTS.md line 51.
  {
    rail: "x402",
    via: "Paid through PayBox",
    requestId: "FeJG9SuofqWU",
    amount: "0.01 USDC",
    tx: {
      label: "Solscan",
      href: `${SOLSCAN}2ycZFaKx86Jhm91qXUgcMY6NkoDdH7qk6GE6zanDuKQBXy4AhrcPE1E11Qxwf8z2WgGuhtXfGdFmTEyvhZk21DVA`,
    },
    facts: "request `FeJG9SuofqWU`, 0.01 USDC",
  },
  // FACTS.md line 52.
  {
    rail: "Base",
    via: "Direct USDC transfer",
    requestId: "XL1u7xuWoAmw",
    amount: "0.5 USDC",
    tx: { label: "Basescan", href: "https://basescan.org/tx/0xff5b5f770e33ee4c2046ae63492e06579ca89c8f750d3990c9359b53f958cff7" },
    facts: "request `XL1u7xuWoAmw`, 0.5 USDC on Base",
  },
];
