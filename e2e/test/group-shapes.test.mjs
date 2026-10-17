// Split-bill shapes (contract/shapes.mjs createGroupReq, groupRes): the fixtures pass, and every break that would
// let a board or a share pay the wrong party, or misreport who has paid, is caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { check, groupIdFor, shapes } from "../../contract/shapes.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const errors = (shape, value) => check(shapes[shape], value).errors.join("\n");

test("group fixtures pass and their ids hash the share ids", async () => {
  for (const name of ["groups.create.res.json", "groups.get.res.json"]) {
    const g = await fixture(name);
    assert.equal(errors("groupRes", g), "");
    assert.equal(groupIdFor({ recipient: g.recipient, token: g.token, totalAtomic: 1_500_000n, shareIds: g.shares.map((s) => s.id) }), g.id);
  }
  assert.equal(errors("createGroupReq", await fixture("groups.create.req.json")), "");
});

test("groupRes catches shares that pay someone else, or ask another amount", async () => {
  const base = await fixture("groups.get.res.json");
  const tamper = (edit) => {
    const g = structuredClone(base);
    edit(g);
    return errors("groupRes", g);
  };
  assert.match(tamper((g) => { g.shares[0].solana_pay_url = g.shares[0].solana_pay_url.replace(g.recipient, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"); }), /recipient differs/);
  assert.match(tamper((g) => { g.shares[2].solana_pay_url = g.shares[2].solana_pay_url.replace("amount=0.5", "amount=0.4"); }), /amount=0.4 differs/);
  assert.match(tamper((g) => { g.shares[1].reference = g.shares[0].reference; }), /does not carry .reference/);
  assert.match(tamper((g) => { g.shares[0].id = g.shares[1].id; }), /not the hash of its payment terms|memo/);
  assert.match(tamper((g) => { g.shares.reverse(); }), /not the hash of its share ids/);
  assert.match(tamper((g) => { g.total = "2"; }), /shares add up to 1\.5/);
  assert.match(tamper((g) => { g.shares[0].link = g.shares[1].link; }), /does not end in \/r\//);
  assert.match(tamper((g) => { g.link = g.link.replace(g.id, "HHHHHHHHHHHH"); }), /does not end in \/g\//);
});

test("groupRes catches a board that misreports who has paid", async () => {
  const base = await fixture("groups.get.res.json");
  const tamper = (edit) => {
    const g = structuredClone(base);
    edit(g);
    return errors("groupRes", g);
  };
  assert.match(tamper((g) => { g.paid_count = 3; }), /paid_count: 3 but 2 shares are paid/);
  assert.match(tamper((g) => { g.amount_received = "1.5"; }), /amount_received: 1\.5 but the shares received 1/);
  assert.match(tamper((g) => { g.shares[0].paid = null; }), /status is paid but paid is null/);
  assert.match(tamper((g) => { g.shares[2].paid = g.shares[0].paid; }), /status is open but paid is set/);
  assert.match(tamper((g) => { g.share_count = 4; }), /share_count: 4 but 3 shares/);
  assert.match(tamper((g) => { g.shares[0].name = "Priya https://evil.example"; }), /sanitized text/);
});

test("createGroupReq: set amounts must fit the total", async () => {
  const base = await fixture("groups.create.req.json");
  assert.match(errors("createGroupReq", { ...base, total: "2" }), /amounts add up to 1\.5, total is 2/);
  assert.match(errors("createGroupReq", { ...base, people: [{ name: "Priya", amount: "1.5" }, { name: "Sam" }] }), /nothing left to split/);
  assert.equal(errors("createGroupReq", { ...base, people: [{ name: "Priya", amount: "1" }, { name: "Sam" }] }), "");
  assert.match(errors("createGroupReq", { ...base, people: [{ name: "Priya" }] }), /1 items, expected 2\.\.20/);
  assert.match(errors("createGroupReq", { ...base, total: "1.0000001" }), /more than 6 decimal places/);
});
