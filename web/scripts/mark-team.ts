// Recompute requests.is_team for payments recorded before OWED_TEAM_WALLETS was set (W2-F, /proof).
// New payments get the flag when they are recorded (lib/requests.ts, lib/x402/store.ts); this brings
// older rows in line with the same rule (lib/team.ts): a settled request is the team's when a team
// wallet paid it. Dry run by default: prints every row it would change, in both directions (rows the
// earlier recipient-or-payer rule flagged are cleared).
//
//   vercel env pull .env.production.local --environment=production
//   node --env-file=.env.production.local --import ./test/setup.mjs scripts/mark-team.ts            # dry run
//   node --env-file=.env.production.local --import ./test/setup.mjs scripts/mark-team.ts --apply    # write
//   ... scripts/mark-team.ts --wallets <addr>,<addr>    # use this list instead of OWED_TEAM_WALLETS
//
// Reads DATABASE_URL like the app. Touches only is_team; nothing here signs or sends funds.
import { sql } from "../lib/db";
import { isTeamSql, teamMismatchSql, teamWallets } from "../lib/team";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const walletsFlag = args.indexOf("--wallets");
const wallets = teamWallets(walletsFlag === -1 ? process.env : { OWED_TEAM_WALLETS: args[walletsFlag + 1] ?? "" });
if (args.some((a, i) => !["--apply", "--wallets"].includes(a) && !(walletsFlag !== -1 && i === walletsFlag + 1))) {
  console.error("usage: scripts/mark-team.ts [--apply] [--wallets <addr>,<addr>]");
  process.exit(2);
}
if (wallets.length === 0) {
  console.error("No team wallets: set OWED_TEAM_WALLETS (comma-separated Solana addresses) or pass --wallets.");
  process.exit(2);
}

const RULE = isTeamSql("$1", "paid_payer");
const DIFF = teamMismatchSql("$1");

const short = (a: string | null) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : (a ?? "-"));
console.log(`team wallets (${wallets.length}): ${wallets.join(", ")}`);
const rows = await sql(
  `select id, kind, status, coalesce(paid_rail, 'solana_pay') as rail, paid_at::text as paid_at, recipient, paid_payer,
          is_team::text as is_team, (${RULE})::text as should
     from requests where ${DIFF} order by paid_at`,
  [wallets],
);
for (const r of rows) {
  console.log(`${r.id}  ${r.kind}  ${r.status}  ${r.rail}  ${r.paid_at}  to ${short(r.recipient)}  from ${short(r.paid_payer)}  is_team ${r.is_team} -> ${r.should}`);
}
if (!apply) {
  console.log(`${rows.length} row(s) would change. Re-run with --apply to write.`);
  process.exit(0);
}
const updated = await sql(`update requests set is_team = ${RULE} where ${DIFF} returning id`, [wallets]);
console.log(`${updated.length} row(s) updated.`);
