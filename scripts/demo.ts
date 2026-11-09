// Runs the three canonical scenarios: ALLOW, WARN (with/without --approve-warn), BLOCK.
import { buildWorld, CHART, IDS } from "../src/world.ts";
import { near } from "../src/util.ts";
import { h, line, printCheck } from "./print.ts";

const approveWarn = process.argv.includes("--approve-warn");
line("NearJev demo · Trust, but verify");
const scenarios = [
  { title: "ALLOW: honest chart, known merchant", receiver: "coffee-shop.testnet", amount: 1, image: CHART.honest },
  { title: "WARN: honest chart, contract whose code changed 10h ago (first call)", receiver: "fresh-dex.testnet", amount: 1, image: CHART.honest },
  { title: "BLOCK: spoofed chart, blocklisted receiver", receiver: "payout-unlock.testnet", amount: 4.9, image: CHART.spoofed },
];
for (const s of scenarios) {
  const w = buildWorld({
    log: (m) => line(`  ${m}`),
    askHuman: async () => { line(`  HUMAN APPROVAL NEEDED → ${approveWarn ? "approved via --approve-warn" : "not approved (pass --approve-warn)"}`); return approveWarn; },
  });
  h(s.title);
  const r = await w.wallet.pay({ agent: IDS.agent, receiver: s.receiver, amountYocto: near(s.amount).toString(), kind: "pay", evidenceImage: s.image });
  printCheck(r.check);
  line(`  wallet status: ${r.status}; signatures: ${w.wallet.signatures.length}`);
}
