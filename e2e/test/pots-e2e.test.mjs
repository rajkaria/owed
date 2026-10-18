// F7 chip-in pots: contract/shapes.mjs re-derives pots with its own code (a third copy of potIdFor) and rejects tampered
// ones; the MCP harness finds a pot proposal's contribution from its memo and checks it belongs to the pot; and the real
// bundle runs start_pot and pay_link on a pot the way PayBox runs it (fresh process, network rules), here with Owed's
// host down, so both refuse cleanly before proposing anything.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { check, potIdFor, shapes } from "../../contract/shapes.mjs";
import { expectedContribution, potIdOf, runE2E } from "../plugin-e2e.mjs";

const BUNDLE = fileURLToPath(new URL("../../plugin/dist/plugin.mjs", import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const pot = fixture("pots.get.res.json");
const contribution = fixture("pots.contribution.res.json");
const errors = (shape, value) => check(shapes[shape], value).errors;

test("shapes: the pot fixtures pass, and the id is the hash of recipient, token and nonce", () => {
  for (const [shape, file] of [["potRes", "pots.get.res.json"], ["potRes", "pots.create.res.json"], ["potContributionRes", "pots.contribution.res.json"], ["ledgerRes", "ledger.pots.res.json"], ["statsRes", "stats.pots.res.json"]]) {
    assert.deepEqual(check(shapes[shape], fixture(file)), { errors: [], warnings: [] }, file);
  }
  assert.equal(potIdFor(pot), pot.id);
});

test("shapes: tampered pots are rejected (id, totals, links, presets, deadline)", () => {
  const cases = [
    [{ nonce: contribution.reference }, /is not the hash of recipient, token and nonce/],
    [{ recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }, /is not the hash/],
    [{ totals: { raised: "50", count: 3 } }, /the contributions add up to 42.5/],
    [{ totals: { raised: "42.5", count: 2 } }, /fewer than the contributions listed/],
    [{ contributions: [...pot.contributions].reverse() }, /not newest first/],
    [{ links: { ...pot.links, transaction_request: pot.links.transaction_request.slice(1) } }, /links\.transaction_request: amounts/],
    [{ links: { ...pot.links, transaction_request: [{ amount: "10", url: `solana:https://www.getowed.xyz/api/v1/pay/${pot.id}?amount=10` }, ...pot.links.transaction_request.slice(1)] } }, /isn't URL-encoded/],
    [{ links: { ...pot.links, transaction_request: [{ amount: "10", url: `solana:${encodeURIComponent(`https://evil.example/api/v1/pay/${pot.id}?amount=10`)}` }, ...pot.links.transaction_request.slice(1)] } }, /not the transaction request/],
    [{ links: { ...pot.links, x402: [{ amount: "5", url: `https://evil.example/x/pot/${pot.id}/5` }, ...pot.links.x402.slice(1)] } }, /links\.x402\[0\]\.url/],
    [{ status: "ended" }, /links\.transaction_request: amounts/],
    [{ presets: ["5", "5", "20"] }, /listed twice/],
    [{ deadline: "2027-02-01T00:00:00Z" }, /within 90 days/],
    [{ any_amount: false, suggested: null, presets: [], links: { ...pot.links, transaction_request: [], x402: [] } }, /any_amount: false without/],
  ];
  for (const [patch, why] of cases) assert.match(errors("potRes", { ...pot, ...patch }).join("\n"), why, JSON.stringify(patch).slice(0, 80));
});

test("shapes: a contribution always ends within a day, names its pot's board, and hashes its terms", () => {
  assert.match(errors("potContributionRes", { ...contribution, expires_at: "2026-10-21T09:05:00Z" }).join("\n"), /more than 24 hours/);
  assert.match(errors("potContributionRes", { ...contribution, expires_at: null }).join("\n"), /always ends/);
  assert.match(errors("potContributionRes", { ...contribution, pot: { ...contribution.pot, link: "https://www.getowed.xyz/pot/11111111111111" } }).join("\n"), /is not \/pot\//);
  assert.match(errors("potContributionRes", { ...contribution, reference: pot.nonce }).join("\n"), /not the hash of its payment terms|does not carry/);
  assert.match(errors("potContributionRes", { ...contribution, payer: { wallet: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", handle: null, sns: null } }).join("\n"), /isn't addressed to anyone/);
  // A plain request read (GET /requests/:id) may carry `pot`, checked the same way.
  assert.deepEqual(check(shapes.getRequestRes, contribution), { errors: [], warnings: [] });
});

test("harness: potIdOf reads every pot link pay_link takes, and nothing else", () => {
  assert.equal(potIdOf(pot.id), pot.id);
  assert.equal(potIdOf(pot.link), pot.id);
  assert.equal(potIdOf(pot.links.transaction_request[0].url), pot.id);
  assert.equal(potIdOf(`solana:https://www.getowed.xyz/api/v1/pay/${pot.id}?amount=3`), pot.id);
  for (const other of ["JArQ6g9JvoWr", "https://www.getowed.xyz/r/JArQ6g9JvoWr", contribution.solana_pay_url, null]) assert.equal(potIdOf(other), null, String(other));
});

test("harness: a pot proposal is checked against the contribution its memo names, which must belong to the pot", async () => {
  const failures = [];
  const warnings = [];
  const fail = (m) => failures.push(m);
  const warn = (m) => warnings.push(m);
  const serve = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const ok = await expectedContribution(pot.id, `owed:${contribution.id}`, "https://www.getowed.xyz", warn, fail, serve(contribution));
  assert.deepEqual([ok.recipient, ok.amount, ok.token, ok.references, ok.memo], [contribution.recipient, "10", "USDC", [contribution.reference], `owed:${contribution.id}`]);
  assert.deepEqual(failures, []);
  assert.equal(await expectedContribution(pot.id, `owed:${contribution.id}`, "https://www.getowed.xyz", warn, fail, serve({ ...contribution, pot: { ...contribution.pot, id: "11111111111111" } })), null);
  assert.match(failures.pop(), /belongs to "11111111111111"/);
  assert.equal(await expectedContribution(pot.id, null, "https://www.getowed.xyz", warn, fail), null);
  assert.match(failures.pop(), /doesn't name a contribution/);
});

const offline = { skip: !existsSync(BUNDLE) && "plugin/dist/plugin.mjs not built" };

test("real bundle: start_pot with Owed's host down refuses with nothing created and no proposal", offline, async () => {
  const report = await runE2E({
    artifact: BUNDLE, tool: "start_pot", down: ["owed-omega.vercel.app"], expectError: true, expectNoProposal: true,
    arguments: { recipient: "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs", title: "e2e pot", suggested_amount: "1", x402_presets: ["1", "2"] },
    expectTexts: ["Nothing was created"],
  });
  assert.deepEqual(report.failures, []);
  assert.ok(report.call.ms < 10_000);
});

test("real bundle: pay_link on a pot (board link, id and QR code) with Owed's host down refuses before any proposal", offline, async () => {
  for (const link of [pot.link, pot.id, pot.links.transaction_request[0].url]) {
    const report = await runE2E({
      artifact: BUNDLE, tool: "pay_link", down: ["owed-omega.vercel.app"], expectError: true, expectNoProposal: true,
      arguments: { link, sender: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: "10" },
      expectTexts: ["this pot can't be checked right now"],
    });
    assert.deepEqual(report.failures, [], link);
  }
});
