// contract/run-tests.mjs against throwaway repo trees: pending until a side has contract.ts, a contract.ts without a
// test fails, and a real contract test runs under the plugin's tsx loader and its result decides the exit code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../../contract/run-tests.mjs", import.meta.url));
const dirs = [];
after(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), "owed-contract-"));
  dirs.push(root);
  const all = { "plugin/package.json": "{}", "web/package.json": "{}", ...files };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
const run = (root, ...flags) => spawnSync(process.execPath, [RUNNER, "--root", root, ...flags], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "" } });

test("no contract.ts yet: pending, and --strict fails", async () => {
  const root = await tree({});
  const relaxed = run(root);
  assert.equal(relaxed.status, 0);
  assert.match(relaxed.stdout, /PENDING plugin contract test[\s\S]*PENDING web contract test/);
  assert.equal(run(root, "--strict").status, 1);
});

test("contract.ts without a contract test fails", async () => {
  const root = await tree({ "plugin/src/contract.ts": "export const x = 1;\n" });
  const result = run(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/contract\.ts exists but no \*contract\*\.test\.ts/);
});

test("contract tests run under tsx and decide the outcome", async () => {
  const passing = "import { test } from 'node:test';\nconst n: number = 1;\ntest('parses', () => { if (n !== 1) throw new Error('x'); });\n";
  const failing = "import { test } from 'node:test';\ntest('parses', () => { throw new Error('fixture rejected'); });\n";
  const good = await tree({ "plugin/src/contract.ts": "", "plugin/test/contract.test.ts": passing, "web/lib/contract.ts": "", "web/lib/contract.test.ts": passing });
  const ok = run(good, "--strict");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /PASS {4}plugin contract test[\s\S]*PASS {4}web contract test/);
  const bad = await tree({ "plugin/src/contract.ts": "", "plugin/test/contract.test.ts": passing, "web/lib/contract.ts": "", "web/lib/contract.test.ts": failing });
  const failed = run(bad);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL {4}web contract test/);
});
