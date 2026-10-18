# W2-G QA suite

Repro tests and hostile-input runs from the QA and security sweep. Findings, severities, owners and
status live outside the repo (`paybox-internal/hackathon/qa-findings.md`); each `QA-nn` here is one
finding there. Nothing in this folder runs in `pnpm unit`, `pnpm test` or CI: the `qa-*` tests fail on
purpose until their finding is fixed.

| Command (repo root) | What it does |
|---|---|
| `command node e2e/qa/run.mjs [QA-nn …]` | Runs `plugin/qa-*.test.ts` (plugin's tsx) and `web/qa-*.test.ts` (web's loader, PGlite for Postgres). Prints `OPEN` (still failing) or `FIXED` per finding, and `CHECKS PASS/FAIL` for `checks-*.test.ts` (attacks already handled; they must pass). |
| `command node e2e/qa/run.mjs --expect-fixed QA-nn` | For owners: exits 1 unless every test of that finding passes on your tree. |
| `command node e2e/qa/hostile/tools.mjs [--create]` | Every plugin tool with hostile input through `e2e/plugin-e2e.mjs` against production (`--base-url` to change). Read-only unless `--create` (rows go to the QA wallet `B7QB…GTTp`, which nobody pays). Cases tagged `QA-nn` print `OPEN`/`FIXED`; anything else that fails is unexpected (exit 1). |
| `command node e2e/qa/hostile/api-fuzz.mjs [base-url]` | Every HTTP route with wrong methods and malformed bodies: no 5xx, contract error bodies, no leaks, `no-store`. Writes nothing (the bodies are invalid on purpose). |

Needs `pnpm install --frozen-lockfile` in `plugin/` and `web/`, and `pnpm build` in `plugin/` for the
bundle. Web repro tests use `@electric-sql/pglite` from `web/node_modules` and a local JSON-RPC double
(`web/qa-harness.ts`) whose transactions follow the jsonParsed shape of the mainnet captures in
`web/test/fixtures/chain/`.

To move a repro into your own suite when you fix it: copy the file next to your tests and change the
`../../../plugin/` or `@/` import prefix; `run.mjs --expect-fixed` should then pass from both places.
