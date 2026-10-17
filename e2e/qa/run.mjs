#!/usr/bin/env node
// W2-G repro suite. Each QA-nn finding in paybox-internal's qa-findings.md has failing tests here that
// pass once the owner's fix lands. Plugin tests run with the plugin's tsx, web tests with web's loader.
//
//   command node e2e/qa/run.mjs              # every finding: "open" (its tests fail) or "fixed" (they pass)
//   command node e2e/qa/run.mjs QA-01 QA-03  # only these
//   command node e2e/qa/run.mjs --expect-fixed QA-01   # exit 1 unless every named finding passes (owners)
//
// Not part of `pnpm unit`/`pnpm test` on purpose: these fail until fixed. Needs `pnpm install` in plugin/ and web/.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const expectFixed = args.includes("--expect-fixed");
const wanted = args.filter((a) => /^QA-\d+$/i.test(a)).map((a) => a.toUpperCase());

const SUITES = [
  { name: "plugin", dir: join(here, "plugin"), cwd: join(root, "plugin"), argv: ["--import", "tsx", "--test", "--test-reporter=tap"] },
  {
    name: "web", dir: join(here, "web"), cwd: join(root, "web"),
    argv: ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--disable-warning=ExperimentalWarning", "--import", "./test/setup.mjs", "--test", "--test-reporter=tap"],
  },
];

const byId = new Map();
for (const suite of SUITES) {
  let files = [];
  try {
    files = readdirSync(suite.dir).filter((f) => /^qa-\d+.*\.test\.ts$/.test(f)).sort();
  } catch {
    continue;
  }
  for (const f of files) {
    const id = `QA-${f.match(/^qa-(\d+)/)[1]}`;
    if (wanted.length && !wanted.includes(id)) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ suite, file: join(suite.dir, f) });
  }
}

let failedExpectation = false;
for (const [id, entries] of [...byId.entries()].sort()) {
  const parts = [];
  let open = false;
  for (const { suite, file } of entries) {
    const r = spawnSync(process.execPath, [...suite.argv, relative(suite.cwd, file)], { cwd: suite.cwd, encoding: "utf8", timeout: 120_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    const pass = Number(out.match(/^# pass (\d+)/m)?.[1] ?? 0);
    const fail = Number(out.match(/^# fail (\d+)/m)?.[1] ?? (r.status === 0 ? 0 : 1));
    if (fail > 0 || r.status !== 0) open = true;
    parts.push(`${suite.name} ${relative(root, file)}: ${pass} pass, ${fail} fail`);
    if (process.env.QA_VERBOSE && r.status !== 0) process.stderr.write(out);
  }
  console.log(`${id}  ${open ? "OPEN " : "FIXED"}  ${parts.join(" · ")}`);
  if (expectFixed && open) failedExpectation = true;
}
if (byId.size === 0) console.log("no QA tests matched");
process.exit(failedExpectation ? 1 : 0);
