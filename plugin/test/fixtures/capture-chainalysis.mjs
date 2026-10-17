// Captures real Chainalysis sanctions-API answers into test/fixtures/chainalysis/*.json.
//
//   cd plugin && node test/fixtures/capture-chainalysis.mjs              # every case
//   cd plugin && node test/fixtures/capture-chainalysis.mjs <name>...    # selected cases
//
// The API key is read from CHAINALYSIS_API_KEY, else from the file named by CHAINALYSIS_API_KEY_FILE
// (default ~/.config/owed/chainalysis-api-key). It is sent only as the X-API-Key header, exactly as
// PayBox's brokered header sends it, and never written: the script refuses to write a fixture that
// contains it. Each fixture holds the request src/screen.ts sends (same URL, same accept header) and
// the reply verbatim (status, content type, body). Tests replay them through screenRecipient and
// fail on any request that was not recorded. Nothing is edited by hand. One exception, done here:
// the no-key reply is Cloudflare's block page, which prints the capturing machine's IP address;
// IP addresses in that page are replaced with "[ip removed]" before it is written.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "chainalysis");
// Must match src/screen.ts.
const url = (address) => `https://public.chainalysis.com/api/v1/address/${encodeURIComponent(address)}`;
const TEAM_WALLET = "FN6G4CQkrM55pnT4npu1U8xegZk7AMnp3ApGvkM4cbvs";
// OFAC's SDN list, "Digital Currency Address - SOL" entries (sdn_advanced.xml, as extracted by
// github.com/0xB10C/ofac-sanctioned-digital-currency-addresses, lists/sanctioned_addresses_SOL.txt).
const OFAC_SOL = [
  "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi",
  "6wjqWWra8ombzaw6VHrG5xpQ972jCYF6bbHiFCbWmr4U",
  "Fc1EwQUZyTEagaDvA1utHXCcZNyG1x2PLt2DfNu1cJdH",
  "FuCC7GoYwt5TsNTjWL23Xx9UKCvC18chjMEFPL3vJDCC",
];
const BAD_KEY = "owed-capture-not-a-real-key";

const CASES = {
  sanctioned: { note: "A Solana address on OFAC's SDN list: Chainalysis returns its designation.", address: OFAC_SOL[0], key: "real", expect: "listed" },
  "sanctioned-2": { note: "Another OFAC SDN Solana address.", address: OFAC_SOL[1], key: "real", expect: "listed" },
  "sanctioned-3": { note: "Another OFAC SDN Solana address.", address: OFAC_SOL[2], key: "real", expect: "listed" },
  "sanctioned-4": { note: "Another OFAC SDN Solana address.", address: OFAC_SOL[3], key: "real", expect: "listed" },
  clean: { note: "The team wallet: on no sanctions list (empty identifications).", address: TEAM_WALLET, key: "real", expect: "clean" },
  "bad-key": { note: "A wrong X-API-Key: 401 Invalid API Key.", address: TEAM_WALLET, key: "bad", expect: 401 },
  "no-key": { note: "No X-API-Key at all (what the plugin gets if PayBox brokers no key): Cloudflare blocks it with an HTML page.", address: TEAM_WALLET, key: "none", expect: 403 },
};

function apiKey() {
  if (process.env.CHAINALYSIS_API_KEY) return process.env.CHAINALYSIS_API_KEY.trim();
  const file = process.env.CHAINALYSIS_API_KEY_FILE ?? join(homedir(), ".config/owed/chainalysis-api-key");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}

const IP = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;

async function capture(name, c, key) {
  const headers = { accept: "application/json" };
  if (c.key === "real") headers["X-API-Key"] = key;
  if (c.key === "bad") headers["X-API-Key"] = BAD_KEY;
  const res = await fetch(url(c.address), { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
  let body = await res.text();
  if (c.key === "none") body = body.replace(IP, "[ip removed]");
  const ok = c.expect === "listed" ? res.status === 200 && /"identifications"\s*:\s*\[\s*\{/.test(body)
    : c.expect === "clean" ? res.status === 200 && /"identifications"\s*:\s*\[\s*\]/.test(body)
    : res.status === c.expect;
  if (!ok) throw new Error(`${name}: expected ${c.expect}, got HTTP ${res.status}; nothing written`);
  const fixture = {
    name, note: c.note, captured_at: new Date().toISOString(),
    request: { method: "GET", url: url(c.address), address: c.address, api_key: { real: "brokered (the real key, not recorded)", bad: BAD_KEY, none: null }[c.key] },
    response: { status: res.status, content_type: res.headers.get("content-type"), body },
  };
  const text = `${JSON.stringify(fixture, null, 1)}\n`;
  if (key && text.includes(key)) throw new Error(`${name}: the reply contains the API key; nothing written`);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.json`), text);
  console.log(`${name}: HTTP ${res.status} ${res.headers.get("content-type")} ${body.length} B`);
}

const key = apiKey();
const wanted = process.argv.slice(2);
for (const [name, c] of Object.entries(CASES)) {
  if (wanted.length && !wanted.includes(name)) continue;
  if (c.key === "real" && !key) {
    console.log(`${name}: skipped (no API key: set CHAINALYSIS_API_KEY or put it in ~/.config/owed/chainalysis-api-key)`);
    continue;
  }
  await capture(name, c, key);
}
