import { test } from "node:test";
import assert from "node:assert/strict";
import { solanaOutputSchema } from "../src/paybox.ts";
import { inputSchema, payLink } from "../src/tools/pay_link.ts";
import { fixture, json, makeDeps, RECIPIENT, SENDER, textOf } from "./helpers.ts";

// F1 in pay_link: a request that carries the requester's X handle ends its preview with a handle check for the payer's
// agent (Owed can't resolve handles; PayBox resolve_username can). The proposal stays exactly the starter's shape: the
// check is text, because pay_link's output schema is the strict PayBox proposal envelope.

const KEY = "io.paybox/transactionProposal";
const request = fixture("payer.get-request.res.json");
const SAM = request.payer.wallet as string;
const route = (body: unknown) => ({ [`GET /api/v1/requests/${request.id}`]: () => json(200, body) });
const pay = (sender: string) => inputSchema.parse({ link: `https://www.getowed.xyz/r/${request.id}`, sender });

test("pay_link: the handle check is the last line, naming the handle and the wallet it must resolve to", async () => {
  const { deps } = makeDeps({ routes: route(request) });
  const r = await payLink(pay(SAM), deps);
  assert.notEqual("isError" in r && r.isError, true, textOf(r));
  const lines = textOf(r).split("\n");
  assert.equal(lines.at(-1), `Handle check: this request says it is from @rajkaria (not verified by Owed). Before approving, call PayBox resolve_username('@rajkaria'); if its Solana address isn't ${RECIPIENT}, tell the user and don't approve.`);
  assert.ok(!lines.some((l) => l.startsWith("This request was addressed to")), "the payer is the addressed wallet");
  const proposal = solanaOutputSchema.parse((r as { structuredContent: unknown }).structuredContent);
  assert.deepEqual(Object.keys(proposal), [KEY]);
});

test("pay_link: paying a request addressed to someone else says so (it still pays it)", async () => {
  const { deps } = makeDeps({ routes: route(request) });
  const text = textOf(await payLink(pay(SENDER), deps));
  assert.match(text, /This request was addressed to @sam_ok \(wallet \S+\), not to this wallet\. Anyone can pay a link, and this settles it/);
});

test("pay_link: no handle, no check line (older requests are unchanged)", async () => {
  const { requester_handle: _h, payer: _p, ...plain } = request;
  const { deps } = makeDeps({ routes: route(plain) });
  assert.doesNotMatch(textOf(await payLink(pay(SENDER), deps)), /Handle check|addressed to/);
});
