// F1 shapes: contract/shapes.mjs checks the payer inbox fixtures for real (signatures, totals, blocked requesters, a
// payer that is the request's own recipient), so the smoke test and the fixtures can't drift apart.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { check, shapes } from "../../contract/shapes.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const errorsOf = (shape, value) => check(shapes[shape], value).errors.join("\n");

test("the inbox signature is verified: another message or a forged signature fails", async () => {
  const req = await fixture("inbox.req.json");
  assert.equal(errorsOf("inboxReq", req), "");
  assert.match(errorsOf("inboxReq", { ...req, signed_message: req.signed_message.replace("10:15:00", "10:15:01") }), /does not verify/);
  assert.match(errorsOf("inboxReq", { ...req, signed_message: req.signed_message.replace("inbox access", "ledger access") }), /must read "Owed inbox access for/);
  const block = await fixture("inbox.block.req.json");
  assert.equal(errorsOf("inboxBlockReq", block), "");
  assert.match(errorsOf("inboxBlockReq", { ...block, action: "unblock" }), /must read "Owed unblock/);
});

test("inbox totals must add up, Base entries stay apart, and a blocked requester is never listed", async () => {
  const res = await fixture("inbox.res.json");
  assert.equal(errorsOf("inboxRes", res), "");
  assert.match(errorsOf("inboxRes", { ...res, totals: [{ ...res.totals[0], amount_due: "13" }, res.totals[1]] }), /not the sum of amount_due/);
  assert.match(errorsOf("inboxRes", { ...res, owed: [...res.owed, res.base[0]] }), /a base entry belongs in base/);
  const blocked = await fixture("inbox.block.res.json");
  assert.equal(errorsOf("inboxBlockRes", blocked), "");
  const leaked = { ...blocked, inbox: { ...blocked.inbox, owed: [{ ...blocked.inbox.owed[0], recipient: blocked.requester }, ...blocked.inbox.owed.slice(1)] } };
  assert.match(errorsOf("inboxBlockRes", leaked), /still lists .* from the blocked requester/);
});

test("a payer can't be the request's own recipient, handles are lower case without @, and a handle needs its wallet", async () => {
  const req = await fixture("payer.create-request.req.json");
  assert.equal(errorsOf("createRequestReq", req), "");
  assert.match(errorsOf("createRequestReq", { ...req, payer: { wallet: req.recipient } }), /the request's own recipient/);
  assert.match(errorsOf("createRequestReq", { ...req, payer: { handle: "sam" } }), /a handle comes with the wallet/);
  const res = await fixture("payer.get-request.res.json");
  assert.equal(errorsOf("getRequestRes", res), "");
  assert.match(errorsOf("getRequestRes", { ...res, requester_handle: "@RajKaria" }), /an X handle, lower case without @/);
  // An older reply without payer fields still passes: they are optional.
  const { payer: _p, requester_handle: _h, ...older } = res;
  assert.equal(errorsOf("getRequestRes", older), "");
});
