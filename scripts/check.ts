// CLI: ask NearJev about one payment, then let the guarded wallet act.
//
//   npm run check -- --receiver coffee-shop.testnet --amount 1 --image fixtures/charts/honest-near-24h.png
//   npm run check -- --receiver fresh-dex.testnet --amount 1 --image fixtures/charts/honest-near-24h.png --approve-warn
//
// WARN never signs unless --approve-warn is passed (the flag stands in for the
// human tapping "approve"). BLOCK never signs.

import { resolve } from "node:path";
import { buildWorld, IDS } from "../src/world.ts";
import { near } from "../src/util.ts";
import { cyan, line, printCheck, red, green, yellow } from "./print.ts";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`NearJev check — Trust, but verify

Usage: npm run check -- [--receiver <account>] [--amount <NEAR>] [--image <chart.png>] [--kind pay|return_to_owner] [--approve-warn]

  BLOCK never signs. WARN signs only with --approve-warn (stands in for a human approving).
  ALLOW signs one FunctionCall to the vault with the agent's function-call key.`);
  process.exit(0);
}
line(cyan("NearJev check · Trust, but verify"));
const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const approveWarn = argv.includes("--approve-warn");
const receiver = arg("receiver") ?? "coffee-shop.testnet";
const amount = Number(arg("amount") ?? "1");
const image = arg("image") ? resolve(process.cwd(), arg("image")!) : undefined;
const kind = (arg("kind") ?? "pay") as "pay" | "return_to_owner";

const w = buildWorld({
  log: (s) => line(`  ${s}`),
  askHuman: async () => {
    line(yellow(`  HUMAN APPROVAL NEEDED: a human would be asked to approve this payment now.`));
    line(approveWarn ? yellow("  --approve-warn given → treating as approved.") : "  (pass --approve-warn to simulate approval)");
    return approveWarn;
  },
});
const r = await w.wallet.pay({ agent: IDS.agent, receiver, amountYocto: near(amount).toString(), kind, evidenceImage: image });
printCheck(r.check);
const msg = `  wallet status: ${r.status}${r.outcome?.error ? ` (${r.outcome.error})` : ""}`;
line(r.status === "signed" ? green(msg) : r.status === "refused_needs_human" ? yellow(msg) : red(msg));
