#!/usr/bin/env node
// W2-G mainnet money checks (rows M1–M4 in qa-findings.md), read-only: the API, the pages and the chain.
// The requests were created on production with ask_for_money (recipient: the team wallet); Raj pays them
// from PayBox/Phantom (PAY ASK W2-G lines in handoff.md). This only reads and grades.
//
//   command node e2e/qa/hostile/money-checks.mjs [--base-url https://www.getowed.xyz] [--rpc https://solana-rpc.publicnode.com]
const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const base = opt("--base-url", "https://www.getowed.xyz");
const rpcUrl = opt("--rpc", "https://solana-rpc.publicnode.com");

const M1A = { id: "HeiQKE21Qu2f", reference: "GzTxuFobazLDpAgp8KgSSKGQjP3orQ3Y8di3Joth7HPW" };
const M1B = { id: "zwJwhWJ8APRR", reference: "A3n3Lmt5zpeZbJFbLA8YoU2g6bjiVpQWcWA73sbfSATi" };
const M2C = { id: "13SqvZHd5VFx", reference: "FvJq7j7tEe1Bv29gefgRWQHKrUXj1MMPxUCh2BioeptW" };
const M3D = { id: "MbFMdrLbtrZW", reference: "Fo2mx9K2Ph3Ln6KL3gtvkUT4vrELUpXyfpgRbL6QhZmg" };

async function rpc(method, params) {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const sigs = async (reference) => (await rpc("getSignaturesForAddress", [reference, { limit: 50, commitment: "confirmed" }])).filter((s) => s.err == null).reverse();
const tx = (sig) => rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
const keysOf = (t) => t.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
const get = async (id) => (await fetch(`${base}/api/v1/requests/${id}`)).json();
const page = async (path) => (await fetch(`${base}${path}`, { headers: { "cache-control": "no-cache" } })).text();

const rows = [];
const row = (name, ok, detail) => rows.push({ name, ok, detail });

// ---- M1: one payment naming A and B, then B paid on its own (QA-03)
{
  const [sa, sb] = await Promise.all([sigs(M1A.reference), sigs(M1B.reference)]);
  const shared = sa.find((s) => sb.some((t) => t.signature === s.signature));
  if (!shared) row("M1 step 1 (one payment naming A and B)", null, "not paid yet");
  else {
    const t = await tx(shared.signature);
    const both = [M1A.reference, M1B.reference].every((r) => keysOf(t).includes(r));
    row("M1 step 1 landed with both references", both, `tx ${shared.signature}`);
    const own = sb.filter((s) => s.signature !== shared.signature);
    const [a, b] = await Promise.all([get(M1A.id), get(M1B.id)]);
    row("M1 one of A/B is paid by the shared payment", [a, b].some((r) => r.paid?.signature === shared.signature), `A ${a.status} · B ${b.status}`);
    if (!own.length) row("M1 step 2 (B paid on its own)", null, `not paid yet; A ${a.status}, B ${b.status}`);
    else row("M1 both A and B paid, by different payments (QA-03)", a.status === "paid" && b.status === "paid" && a.paid.signature !== b.paid.signature,
      `A ${a.status} ${a.paid?.signature?.slice(0, 12) ?? ""} · B ${b.status} ${b.paid?.signature?.slice(0, 12) ?? ""} · B's own payment ${own[0].signature.slice(0, 12)}`);
  }
}

// ---- M2: half of C with its reference → underpaid, pay_link refuses, page shows what's left
{
  const s = await sigs(M2C.reference);
  const c = await get(M2C.id);
  if (!s.length) row("M2 underpayment", null, `not paid yet; C is ${c.status}`);
  else {
    row("M2 C is underpaid with 0.01 of 0.02", c.status === "underpaid" && c.paid?.amount === "0.01", `C ${c.status} paid ${c.paid?.amount ?? "-"} sig ${c.paid?.signature ?? "-"}`);
    const html = await page(`/r/${M2C.id}`);
    row("M2 page shows the partial payment and what is left", /0\.01/.test(html) && /left|remaining|still owe|Underpaid|Partly paid/i.test(html), "pay page text");
  }
}

// ---- M3/M4: double payment of D; Paid survives a hard refresh; Paid hides the QR and wallet button
{
  const s = await sigs(M3D.reference);
  const d = await get(M3D.id);
  if (!s.length) row("M3 double payment", null, `not paid yet; D is ${d.status}`);
  else {
    row("M3 D is paid by the FIRST payment", d.status === "paid" && d.paid?.signature === s[0].signature, `D ${d.status} ${d.paid?.signature ?? ""}; payments on chain: ${s.length}`);
    if (s.length < 2) row("M3 second payment", null, "only one payment so far");
    else row("M3 second payment ignored (still the first signature)", d.paid?.signature === s[0].signature, `second ${s[1].signature}`);
    const html = await page(`/r/${M3D.id}`);
    row("M4 hard refresh (server render) shows Paid", /Paid/.test(html) && !/Waiting for payment/.test(html), "SSR HTML");
    row("M4 Paid page hides the wallet button", !/href="solana:/.test(html), "no solana: link in the paid page");
    const st = await (await fetch(`${base}/api/v1/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [M3D.id] }) })).json();
    row("M4 /status agrees", st.results?.[0]?.status === "paid" && st.results[0].signature === s[0].signature, JSON.stringify(st.results?.[0] ?? {}));
  }
}

for (const r of rows) console.log(`${r.ok === null ? "WAIT" : r.ok ? "PASS" : "FAIL"}  ${r.name}  · ${r.detail}`);
process.exit(rows.some((r) => r.ok === false) ? 1 : 0);
