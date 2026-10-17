#!/usr/bin/env node
// Runs each side's contract test (plugin/src/contract.ts and web/lib/contract.ts must both parse every fixture).
//   node contract/run-tests.mjs [--strict]
// Per side: a `test:contract` package script wins; otherwise every *contract*.test.ts file runs under node:test
// with the plugin's tsx loader (tsx also resolves web's `@/` tsconfig paths). A side with neither contract.ts nor a
// test is "pending" (a failure with --strict). A side with contract.ts but no test always fails.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const strict = process.argv.includes("--strict");
const tsxLoader = join(root, "plugin/node_modules/tsx/dist/loader.mjs");
const sides = [
  { name: "plugin", dir: join(root, "plugin"), contract: "src/contract.ts" },
  { name: "web", dir: join(root, "web"), contract: "lib/contract.ts" },
];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".git", ".vercel", "coverage"]);

function findTests(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) findTests(join(dir, entry.name), found);
    } else if (/contract.*\.test\.m?ts$/.test(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found.sort();
}

function run(command, args, cwd) {
  console.log(`$ (cd ${relative(root, cwd) || "."} && ${[command, ...args].join(" ")})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  return result.status === 0;
}

const outcomes = [];
for (const side of sides) {
  const hasContract = existsSync(join(side.dir, side.contract));
  const scripts = JSON.parse(readFileSync(join(side.dir, "package.json"), "utf8")).scripts ?? {};
  let outcome;
  if (scripts["test:contract"]) {
    outcome = run("pnpm", ["run", "test:contract"], side.dir) ? "pass" : "fail";
  } else {
    const tests = findTests(side.dir);
    if (tests.length) {
      if (!existsSync(tsxLoader)) {
        console.error(`tsx loader missing at ${relative(root, tsxLoader)}: run pnpm install in plugin/ first`);
        outcome = "fail";
      } else {
        const files = tests.map((file) => relative(side.dir, file));
        outcome = run(process.execPath, ["--import", pathToFileURL(tsxLoader).href, "--test", ...files], side.dir) ? "pass" : "fail";
      }
    } else if (hasContract) {
      console.error(`${side.name}: ${side.contract} exists but no *contract*.test.ts parses the fixtures`);
      outcome = "fail";
    } else {
      outcome = "pending";
    }
  }
  outcomes.push({ side: side.name, outcome });
}

for (const { side, outcome } of outcomes) {
  console.log(`${outcome.toUpperCase().padEnd(7)} ${side} contract test${outcome === "pending" ? " (not written yet)" : ""}`);
  if (outcome === "pending" && process.env.GITHUB_ACTIONS) console.log(`::warning title=contract::${side} has no contract test yet`);
}
const failed = outcomes.some(({ outcome }) => outcome === "fail" || (strict && outcome === "pending"));
process.exitCode = failed ? 1 : 0;
