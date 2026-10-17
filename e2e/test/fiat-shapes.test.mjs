// contract/shapes.mjs local-currency shapes: the fixtures pass with no warnings, and a quote that doesn't produce
// its USDC amount, or that a server changed after the fact, fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { check, fixtureShapes, shapes, usdcAtomicForQuote } from "../../contract/shapes.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const errors = (shape, value) => check(shapes[shape], value).errors;
const FILES = Object.keys(fixtureShapes).filter((name) => name.startsWith("fiat."));

test("every fiat fixture is mapped and passes with no warnings", () => {
  assert.equal(FILES.length, 9);
  for (const name of FILES) assert.deepEqual(check(shapes[fixtureShapes[name]], fixture(name)), { errors: [], warnings: [] }, name);
});

test("USDC for a quote is amount / rate rounded up to 6 decimals, exact", () => {
  assert.equal(usdcAtomicForQuote({ amount: "1200", rate: "94.95975" }), 12_636_934n); // 12.6369340...
  assert.equal(usdcAtomicForQuote({ amount: "100", rate: "100" }), 1_000_000n); // exact: no rounding
  assert.equal(usdcAtomicForQuote({ amount: "1", rate: "3" }), 333_334n); // 0.3333333… rounds up
  assert.equal(usdcAtomicForQuote({ amount: "60000", rate: "158.0085" }), 379_726_408n); // JPY, zero decimals
});

test("fiat shapes reject a quote that doesn't add up", () => {
  const res = fixture("fiat.create-request.res.json");
  const get = fixture("fiat.get-request.res.json");
  const group = fixture("fiat.groups.create.res.json");
  const invoice = fixture("fiat.invoices.create.res.json");
  const cases = [
    ["fiatCreateRequestRes", "a higher rate", { ...res, fiat: { ...res.fiat, rate: "90" } }],
    ["fiatCreateRequestRes", "an amount that isn't the URL's", { ...res, amount: "12.636935" }],
    ["fiatCreateRequestRes", "USD as the currency", { ...res, fiat: { ...res.fiat, currency: "USD" } }],
    ["fiatCreateRequestRes", "no quote", (({ fiat, ...rest }) => rest)(res)],
    ["fiatGetRequestRes", "a rounded-down amount", { ...get, fiat: { ...get.fiat, amount: "1200.01" } }],
    ["fiatGetRequestRes", "a SOL request", { ...get, token: "SOL" }],
    ["fiatStatusRes", "a status quote for another amount", { results: [{ ...fixture("fiat.status.res.json").results[0], fiat: { ...get.fiat, amount: "1300" } }] }],
    ["fiatGroupRes", "a share at another rate", { ...group, shares: group.shares.map((s, i) => (i ? s : { ...s, fiat: { ...s.fiat, rate: "0.9" } })) }],
    ["fiatGroupRes", "a board total that isn't the shares'", { ...group, fiat: { ...group.fiat, amount: "50" } }],
    ["fiatInvoiceRes", "items that don't add up to the quote", { ...invoice, items: [{ ...invoice.items[0], unit_price: "40000", amount: "40000" }, invoice.items[1]] }],
    ["fiatInvoiceRes", "a total the quote doesn't give", { ...invoice, total: "379.726407" }],
    ["fiatCreateRequestReq", "a SOL ask", { ...fixture("fiat.create-request.req.json"), token: "SOL" }],
  ];
  for (const [shape, label, value] of cases) assert.notDeepEqual(errors(shape, value), [], label);
});
