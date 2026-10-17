// W2-E sanctions screen: src/screen.ts (OFAC SDN list, built from Treasury's file into src/ofac-sdn.ts)
// and its call in every tool that creates or pays a request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OFAC_SDN } from "../src/ofac-sdn.ts";
import { solanaOutputSchema } from "../src/paybox.ts";
import { screenRecipient, sdnEntry, type Screening } from "../src/screen.ts";
import { askForMoney, inputSchema as askInput, outputSchema as askOutput } from "../src/tools/ask_for_money.ts";
import { createInvoice, inputSchema as invoiceInput } from "../src/tools/create_invoice.ts";
import { inputSchema as payInput, payLink } from "../src/tools/pay_link.ts";
import { inputSchema as splitInput, splitBill } from "../src/tools/split_bill.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf } from "./helpers.ts";

/** The four Solana addresses on OFAC's SDN list (Treasury SDN.XML published 2026-10-15). */
const SDN_SOLANA = [
  ["42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi", "ILLICIT-DRUGS-EO14059"],
  ["6wjqWWra8ombzaw6VHrG5xpQ972jCYF6bbHiFCbWmr4U", "SDGT"],
  ["Fc1EwQUZyTEagaDvA1utHXCcZNyG1x2PLt2DfNu1cJdH", "CYBER4"],
  ["FuCC7GoYwt5TsNTjWL23Xx9UKCvC18chjMEFPL3vJDCC", "CYBER4"],
] as const;
const LISTED = SDN_SOLANA[0][0];

test("the snapshot is Treasury's: every Solana SDN address, EVM ones lower-case, a publish date", () => {
  assert.match(OFAC_SDN.published, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(OFAC_SDN.source, "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML");
  assert.deepEqual(OFAC_SDN.addresses.filter((e) => e.kind === "solana").map((e) => e.address).sort(), SDN_SOLANA.map(([a]) => a).sort());
  assert.ok(OFAC_SDN.addresses.filter((e) => e.kind === "evm").length > 100);
  for (const e of OFAC_SDN.addresses) if (e.kind === "evm") assert.equal(e.address, e.address.toLowerCase());
});

test("every Solana SDN address is blocked with a plain message naming the list, the entry and the program; no link", async () => {
  for (const [address, program] of SDN_SOLANA) {
    const result = await screenRecipient(address);
    assert.equal(result.ok, false, address);
    const message = (result as { message: string }).message;
    assert.match(message, new RegExp(`^The address ${address.slice(0, 4)}…${address.slice(-4)} is on the U\\.S\\. Treasury's OFAC sanctions list \\(SDN entry "[^"]+", program ${program}; list of \\d{4}-\\d{2}-\\d{2}\\)\\. Owed doesn't create or pay requests for sanctioned addresses\\.$`));
    assert.doesNotMatch(message, /https?:|www\./);
  }
});

test("other addresses are clear; EVM matches ignore case; the screen never touches the network", async () => {
  const fetchSpy = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("the screen must not use the network"); }) as typeof fetch;
  try {
    assert.deepEqual(await screenRecipient(RECIPIENT), { ok: true, screening: "clear" });
    assert.deepEqual(await screenRecipient(SENDER), { ok: true, screening: "clear" });
    const evm = OFAC_SDN.addresses.find((e) => e.kind === "evm")!.address;
    assert.equal((await screenRecipient(evm.toUpperCase().replace("0X", "0x"))).ok, false);
    assert.equal(sdnEntry(` ${LISTED} `)?.address, LISTED);
    assert.equal(sdnEntry(LISTED.toLowerCase()), null, "base58 is case-sensitive");
  } finally {
    globalThis.fetch = fetchSpy;
  }
});

// ---------------------------------------------------------------- tools (real screen, real list)

const created = fixture("create-request.res.json");

test("ask_for_money: an SDN address is refused before anything is created; a clean one says screening: clear", async () => {
  const listed = makeDeps({ screenRecipient, routes: { "POST /api/v1/requests": () => json(201, created) } });
  const refused = await askForMoney(askInput.parse({ recipient: LISTED, amount: "1" }), listed.deps);
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /OFAC sanctions list/);
  assert.equal(listed.rec.calls.length, 0, "no call to Owed's server");

  const clean = makeDeps({ screenRecipient, routes: { "POST /api/v1/requests": () => json(201, created) } });
  const ok = await askForMoney(askInput.parse({ recipient: RECIPIENT, amount: "15" }), clean.deps);
  assert.equal(askOutput.parse((ok as { structuredContent: unknown }).structuredContent).screening, "clear");
  assert.doesNotMatch(textOf(ok), /screen/i);
});

test("pay_link: a raw link to an SDN address is refused before any proposal; a clean one proposes", async () => {
  const link = `solana:${LISTED}?amount=0.01&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=${RECIPIENT}`;
  const { deps, rec } = makeDeps({ screenRecipient });
  const result = await payLink(payInput.parse({ link, sender: SENDER }), deps);
  assert.equal(result.isError, true);
  assert.match(textOf(result), /OFAC sanctions list .* Nothing was sent\.$/);
  assert.equal(rec.built.length, 0);

  const open = { ...fixture("get-request.res.json"), status: "open", paid: null };
  const clean = makeDeps({ screenRecipient, routes: { [`GET /api/v1/requests/${open.id}`]: () => json(200, open) } });
  const paid = await payLink(payInput.parse({ link: `https://owed.link/r/${open.id}`, sender: SENDER }), clean.deps);
  assert.ok(solanaOutputSchema.safeParse((paid as { structuredContent: unknown }).structuredContent).success, textOf(paid));
});

test("split_bill and create_invoice screen through Deps by default", async () => {
  const screened: string[] = [];
  const blocked = async (addr: string): Promise<Screening> => { screened.push(addr); return { ok: false, message: "listed" }; };
  const split = makeDeps({ screenRecipient: blocked, routes: {} });
  assert.equal(textOf(await splitBill(splitInput.parse({ recipient: RECIPIENT, total: "2", token: "USDC", title: "Pizza", people: [{ name: "A" }, { name: "B" }] }), split.deps)), "listed");
  const inv = makeDeps({ screenRecipient: blocked, routes: {} });
  assert.equal(textOf(await createInvoice(invoiceInput.parse({
    recipient: RECIPIENT, token: "USDC", business_name: "B", client_name: "C", items: [{ description: "x", quantity: "1", unit_price: "1" }], due_date: "2026-11-01",
  }), inv.deps)), "listed");
  assert.deepEqual(screened, [RECIPIENT, RECIPIENT]);
  assert.equal(split.rec.calls.length + inv.rec.calls.length, 0);
});
