#!/usr/bin/env node
// Lints contract/fixtures/*.json against contract/shapes.mjs: every file has a shape, every shape accepts its file,
// and cross-field facts hold (the solana: URL carries the same recipient, amount, token, reference and memo as the
// JSON around it). No dependencies: `node contract/check.mjs`.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { check, fixtureShapes, shapes } from "./shapes.mjs";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export async function checkFixtures(dir = fixturesDir) {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const results = [];
  for (const name of files) {
    const shapeName = fixtureShapes[name];
    if (!shapeName) {
      results.push({ name, errors: ["no shape mapped in contract/shapes.mjs fixtureShapes"], warnings: [] });
      continue;
    }
    let value;
    try {
      value = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch (error) {
      results.push({ name, errors: [`invalid JSON: ${error.message}`], warnings: [] });
      continue;
    }
    results.push({ name, shape: shapeName, ...check(shapes[shapeName], value) });
  }
  for (const name of Object.keys(fixtureShapes)) {
    if (!files.includes(name)) results.push({ name, errors: ["mapped in fixtureShapes but missing from contract/fixtures/"], warnings: [] });
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const results = await checkFixtures();
  let failed = 0;
  for (const { name, shape, errors, warnings } of results) {
    const status = errors.length ? "FAIL" : warnings.length ? "WARN" : "PASS";
    if (errors.length) failed += 1;
    console.log(`${status}  ${name}${shape ? `  (${shape})` : ""}`);
    for (const line of errors) console.log(`      error: ${line}`);
    for (const line of warnings) console.log(`      warn:  ${line}`);
  }
  console.log(`\n${results.length - failed}/${results.length} fixtures match contract/shapes.mjs`);
  process.exitCode = failed ? 1 : 0;
}
