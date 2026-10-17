// Local-only fixture provider so the pages can be built before the API lands.
// lib/request-source.ts loads this file only when NODE_ENV === "development"
// and OWED_DEV_FIXTURES === "1". It is never reached in a production build.
// Every variant is derived from contract/fixtures/get-request.res.json.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PublicRequest } from "./public-api";

async function base(): Promise<PublicRequest> {
  const file = path.join(process.cwd(), "..", "contract", "fixtures", "get-request.res.json");
  return JSON.parse(await readFile(file, "utf8")) as PublicRequest;
}

export async function getFixtureRequest(id: string): Promise<PublicRequest | null> {
  const paid = await base();
  const open: PublicRequest = { ...paid, status: "open", paid: null };
  const url = (amount: string, extra = "") =>
    `solana:${paid.recipient}?amount=${amount}&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=${paid.reference}${extra}`;

  const variants: PublicRequest[] = [
    paid,
    { ...open, id: "Bq3wL8mNc2", amount: "4.5", solana_pay_url: url("4.5", "&label=Raj&message=coffee"), for: "coffee", note: null },
    { ...paid, id: "Un4erPa1d1", status: "underpaid", paid: { ...paid.paid!, amount: "10" } },
    {
      ...open,
      id: "F1aggedXyz",
      requester_name: "MoonPay Support",
      payer_name: null,
      for: "refund https://moonpay-refund.example/claim",
      note: "Your refund is ready, pay the fee to release it",
      flags: ["brand_word:moonpay", "brand_word:refund"],
    },
    { ...open, id: "AnonReq123", requester_name: null, payer_name: null, for: null, note: null },
    {
      ...open,
      id: "So1Req4567",
      token: "SOL",
      amount: "0.25",
      for: "gas money",
      note: null,
      solana_pay_url: `solana:${paid.recipient}?amount=0.25&reference=${paid.reference}&label=Raj&message=gas%20money`,
    },
    {
      ...open,
      id: "LongText99",
      amount: "1250.75",
      requester_name: "Alexandria Catherine Montgomery",
      payer_name: "Bartholomew Fitzgerald",
      for: "Weekend cabin by the lake, split four ways, plus groceries, firewood and the boat",
      note: "Thanks for organising the trip! Pay when you can, no rush at all. The receipts are in the group chat if you want to check the numbers first.",
      solana_pay_url: url("1250.75"),
    },
  ];
  return variants.find((v) => v.id === id) ?? null;
}
