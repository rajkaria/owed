// Grades web/scripts/smoke.mjs against a local HTTP double of the Owed app (test-only), built from the contract
// fixtures: one state with nothing deployed, one fully deployed, one with regressions.
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { isPubkey, parseSolanaPayUrl, TEAM_WALLET, USDC_MINT } from "../../contract/shapes.mjs";
import { runSmoke } from "../../web/scripts/smoke.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`../../contract/fixtures/${name}`, import.meta.url), "utf8"));
const ID = "SmokeTestA";
const REFERENCE = "8nUqYfwq3V4KQ5Lq1jqcUFdC1V2bQe2KJ7m2p3sYQk9e";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000, 1)]);

async function serve(app) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://local");
    let body = "";
    for await (const chunk of req) body += chunk;
    const send = (status, type, payload, matched = "/404") => {
      res.writeHead(status, { "content-type": type, "x-matched-path": matched });
      res.end(typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    };
    const json = (status, payload, matched) => send(status, "application/json", payload, matched);
    const html = (status, text, matched) => send(status, "text/html; charset=utf-8", `<!DOCTYPE html><html><body>${text}</body></html>`, matched);
    try {
      await app({ req, url, body, send, json, html });
    } catch (error) {
      send(500, "text/plain", String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** What a fully deployed app answers, from the contract fixtures. */
const deployed = async () => ({
  stats: await fixture("stats.res.json"),
  planStats: await fixture("plans.stats.res.json"),
  ledgerOwner: (await fixture("ledgers.create.req.json")).owner,
});

const notDeployed = ({ url, html }) => (url.pathname === "/" ? html(200, "<h1>Owed</h1>", "/") : html(404, "This page could not be found."));

function deployedApp({ stats, planStats, ledgerOwner, bugs = {} }) {
  let created = null;
  const solanaPayUrl = `solana:${TEAM_WALLET}?amount=0.01&spl-token=${USDC_MINT}&reference=${REFERENCE}&label=Owed%20smoke&message=smoke%20check&memo=owed%3A${ID}`;
  const error = (code, message) => ({ error: { code, message } });
  return async ({ req, url, body, send, json, html }) => {
    const path = url.pathname;
    if (req.method === "GET" && path === "/") return html(200, "<h1>Owed</h1>", "/");
    if (req.method === "GET" && path === "/p") return html(200, "<h1>Pay</h1>", "/p");
    if (req.method === "GET" && path === `/r/${ID}/opengraph-image`) return send(200, "image/png", PNG, "/r/[id]/opengraph-image");
    if (req.method === "GET" && path.startsWith("/r/")) {
      if (path !== `/r/${ID}` || !created) return html(404, "not found", "/r/[id]");
      const forText = bugs.leakUrl ? "smoke check https://example.com/x" : "smoke check";
      return send(200, "text/html", `<html><head><meta property="og:title" content="Owed smoke is asking you for 0.01 USDC"/><meta property="og:image" content="/r/${ID}/opengraph-image?abc&amp;v=1"/></head><body>0.01 USDC "${forText}"</body></html>`, "/r/[id]");
    }
    if (req.method === "GET" && path === "/api/v1/stats") return bugs.statsBroken ? html(500, "Internal Server Error", "/api/v1/stats") : json(200, stats, "/api/v1/stats");
    if (req.method === "GET" && path === "/api/v1/plans/stats") return json(200, planStats, "/api/v1/plans/stats"); // F2
    // F6 ledgers and F8 refunds: 12-character ids; nothing exists in this double.
    if (req.method === "GET" && path.startsWith("/l/")) return html(404, "not found", "/l/[id]");
    for (const [prefix, matched, what] of [["/api/v1/ledgers/", "/api/v1/ledgers/[id]", "ledger"], ["/api/v1/refunds/", "/api/v1/refunds/[id]", "refund"]]) {
      if (req.method !== "GET" || !path.startsWith(prefix)) continue;
      const id = path.slice(prefix.length);
      return /^[1-9A-HJ-NP-Za-km-z]{12}$/.test(id) ? json(404, error("not_found", `no ${what} with this id`), matched) : json(400, error("invalid_input", `id must be a 12-character Owed ${what} id`), matched);
    }
    // F7 pots: 14-character ids; nothing exists in this double, and it refuses a token-account recipient like the real route.
    if (req.method === "GET" && path.startsWith("/pot/")) return html(404, "not found", "/pot/[id]");
    if (req.method === "GET" && path.startsWith("/api/v1/pots/")) {
      const id = path.slice("/api/v1/pots/".length);
      return /^[1-9A-HJ-NP-Za-km-z]{14}$/.test(id) ? json(404, error("not_found", "no pot with this id"), "/api/v1/pots/[id]") : json(400, error("invalid_input", "id must be a 14-character Owed pot id"), "/api/v1/pots/[id]");
    }
    if (req.method === "POST" && path === "/api/v1/pots") return json(400, error("invalid_input", "recipient must be a wallet address, not a token account or program address"), "/api/v1/pots");
    if (req.method === "GET" && path.startsWith("/x/pot/")) return json(404, error("not_found", "no pot with this id"), "/x/pot/[potId]/[amount]");
    if (req.method === "POST" && path === "/api/v1/ledgers") {
      const input = JSON.parse(body);
      // The real route refuses an owner off the ed25519 curve; the double knows the one wallet its fixture uses.
      if (input.owner !== ledgerOwner) return json(400, error("invalid_input", "owner: must be the owner's Solana wallet address, one that can sign (not a token account)"), "/api/v1/ledgers");
      return json(503, error("upstream_unavailable", "this double never creates a ledger"), "/api/v1/ledgers");
    }
    if (req.method === "GET" && path.startsWith("/api/v1/requests/")) {
      const id = path.split("/").pop();
      if (id === ID && created) {
        return json(200, {
          id: ID, kind: "single", recipient: TEAM_WALLET, amount: "0.01", token: "USDC", payer_name: "Smoke test",
          for: "smoke check", note: "Owed smoke run, mentions PayBox", requester_name: "Owed smoke", status: "open",
          solana_pay_url: solanaPayUrl, reference: REFERENCE, x402_url: null, created_at: "2026-10-17T05:00:00.123Z", paid: null,
          flags: ["brand_word:paybox"],
        }, "/api/v1/requests/[id]");
      }
      if (/^[1-9A-HJ-NP-Za-km-z]{10}$/.test(id)) return bugs.unknownIs200 ? json(200, { id }) : json(404, error("not_found", "no such request"), "/api/v1/requests/[id]");
      return json(400, error("invalid_input", "bad id"), "/api/v1/requests/[id]");
    }
    if (req.method === "POST" && path === "/api/v1/requests") {
      let input;
      try { input = JSON.parse(body); } catch { return json(400, error("invalid_input", "body is not JSON"), "/api/v1/requests"); }
      if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(input.amount) || !isPubkey(input.recipient)) return json(400, error("invalid_input", "bad amount or recipient"), "/api/v1/requests");
      created = input;
      return json(201, {
        id: ID, link: `https://owed.link/r/${ID}`, solana_pay_url: solanaPayUrl, qr_url: `https://owed.link/api/qr/${ID}.png`,
        reference: REFERENCE, x402_url: null, created_at: "2026-10-17T05:00:00.123Z", flags: ["brand_word:paybox"],
      }, "/api/v1/requests");
    }
    if (req.method === "POST" && path === "/api/v1/status") {
      const { ids } = JSON.parse(body);
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20) return json(400, error("invalid_input", "1 to 20 ids"), "/api/v1/status");
      return json(200, { results: ids.map((id) => (id === ID && created ? { id, status: "open", amount_requested: "0.01", token: "USDC" } : { id, status: "not_found" })) }, "/api/v1/status");
    }
    if (req.method === "POST" && path === "/api/v1/status-raw") {
      const parsed = parseSolanaPayUrl(JSON.parse(body).solana_pay_url);
      if (!parsed.ok || parsed.kind !== "transfer") return json(400, error("invalid_input", "transfer requests only"), "/api/v1/status-raw");
      return json(200, { status: "open", amount_requested: parsed.amount, token: parsed.token }, "/api/v1/status-raw");
    }
    if (req.method === "GET" && path.startsWith("/api/qr/")) {
      const match = path.match(/^\/api\/qr\/([^/.]+)\.(png|svg)$/);
      if (!match || match[1] !== ID || !created) return json(404, error("not_found", "no such request"), "/api/qr/[id]");
      return match[2] === "png" ? send(200, "image/png", PNG, "/api/qr/[id]") : send(200, "image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg">${"<rect/>".repeat(40)}</svg>`, "/api/qr/[id]");
    }
    return html(404, "This page could not be found.");
  };
}

test("nothing deployed yet: pending is OK, --strict fails", async () => {
  const server = await serve(notDeployed);
  try {
    const report = await runSmoke({ base: server.base });
    assert.equal(report.ok, true);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.pass, 2); // landing + unknown page is 404
    assert.equal(report.summary.pending, 24); // 14 + F6 ledger page and 3 ledger routes + F8 refund lookup + F7 pot page and 4 pot routes
    assert.equal(report.summary.skip, 6);
    const strict = await runSmoke({ base: server.base, strict: true });
    assert.equal(strict.ok, false);
    assert.equal(strict.summary.fail, 24);
    assert.ok(strict.results.every((result) => result.status !== "fail" || result.detail.includes("--strict")));
  } finally {
    await server.close();
  }
});

test("fully deployed: --create checks one request end to end and --strict passes", async () => {
  const server = await serve(deployedApp(await deployed()));
  try {
    const report = await runSmoke({ base: server.base, strict: true, create: true });
    const notPassing = report.results.filter((result) => result.status !== "pass");
    assert.deepEqual(notPassing, []);
    assert.equal(report.summary.pass, report.results.length);
    assert.ok(report.results.some((result) => result.name === "preview image" && result.status === "pass"));
    assert.ok(report.results.some((result) => result.name.startsWith("create (real") && result.status === "pass"));
  } finally {
    await server.close();
  }
});

test("--id reads an existing request without creating anything", async () => {
  const server = await serve(deployedApp(await deployed()));
  try {
    const report = await runSmoke({ base: server.base, id: ID });
    // The double only knows the request after a create, so the reads fail: proves --id never POSTs a create.
    assert.ok(!report.results.some((result) => result.name.startsWith("create (real")));
    assert.equal(report.results.find((result) => result.name === "get request").status, "fail");
  } finally {
    await server.close();
  }
});

test("regressions fail with a reason", async () => {
  const stats = await fixture("stats.res.json");
  const server = await serve(deployedApp({ ...(await deployed()), stats: { ...stats, paid_volume_usdc: 12.5 }, bugs: { unknownIs200: true, leakUrl: true } }));
  try {
    const report = await runSmoke({ base: server.base, create: true });
    const failed = Object.fromEntries(report.results.filter((result) => result.status === "fail").map((result) => [result.name, result.detail]));
    assert.match(failed.stats, /paid_volume_usdc: expected string, got number/);
    assert.match(failed["get unknown id"], /status 200, expected 404/);
    assert.match(failed["pay page"], /requester-written URL reached the page/);
    assert.equal(report.ok, false);
  } finally {
    await server.close();
  }
  const broken = await serve(deployedApp({ ...(await deployed()), stats, bugs: { statsBroken: true } }));
  try {
    const report = await runSmoke({ base: broken.base });
    assert.match(report.results.find((result) => result.name === "stats").detail, /status 500, expected 200.*content-type text\/html/);
  } finally {
    await broken.close();
  }
});
