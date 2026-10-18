#!/usr/bin/env node
// Fails when the bundle POST /api/mcp runs (web/mcp/owed-plugin.mjs) is not the plugin build (plugin/dist/plugin.mjs),
// or when web/mcp/owed-plugin.meta.json no longer describes it. Run it after the plugin build (CI: after `pnpm test`).
//
//   node scripts/check-mcp-bundle.mjs              # compare with plugin/dist/plugin.mjs
//   node scripts/check-mcp-bundle.mjs --built F    # compare with another build of plugin.mjs
//
// Exit codes: 0 in sync, 1 drift (fix: node scripts/sync-mcp-bundle.mjs, then commit web/mcp/), 2 could not check.
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT, BundleScriptError, describeBundle, META, metaJson, readBundle, sha256, TARGET } from "./sync-mcp-bundle.mjs";

const rel = (path) => relative(process.cwd(), path) || ".";
const FIX = "run `node scripts/sync-mcp-bundle.mjs` and commit web/mcp/";

/** Every way the committed copy can disagree with the build; empty when they are in sync. */
export async function checkBundle({ built = BUILT } = {}) {
  const problems = [];
  const fresh = readBundle(built); // exit 2 when there is no build to compare with
  if (!existsSync(TARGET)) return [`${rel(TARGET)} is missing`];
  const committed = readFileSync(TARGET);
  if (sha256(committed) !== sha256(fresh)) {
    problems.push(`${rel(TARGET)} (${committed.length} bytes, sha256 ${sha256(committed)}) differs from ${rel(built)} (${fresh.length} bytes, sha256 ${sha256(fresh)})`);
  }
  let meta;
  try {
    meta = readFileSync(META, "utf8");
  } catch {
    problems.push(`${rel(META)} is missing`);
    return problems;
  }
  // The meta file must be exactly what the sync script writes for the committed bytes (digest, size and the tool
  // list the bundle itself returns), so a hand edit or a partial sync is caught too.
  const expected = metaJson(await describeBundle(TARGET, committed));
  if (meta !== expected) problems.push(`${rel(META)} does not describe ${rel(TARGET)}`);
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  let built;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--built" && args[i + 1]) built = resolve(args[++i]);
    else throw new BundleScriptError(`usage: node scripts/check-mcp-bundle.mjs [--built <plugin.mjs>]`, 2);
  }
  const problems = await checkBundle({ built });
  if (problems.length) {
    for (const problem of problems) console.error(`check-mcp-bundle: ${problem}`);
    console.error(`check-mcp-bundle: drift: ${FIX}`);
    process.exit(1);
  }
  const committed = readFileSync(TARGET);
  console.log(`check-mcp-bundle: ok · ${rel(TARGET)} = ${rel(built ?? BUILT)} · ${committed.length} bytes · sha256 ${sha256(committed)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`check-mcp-bundle: ${error.message}`);
    process.exit(error instanceof BundleScriptError ? error.exitCode : 2);
  });
}
