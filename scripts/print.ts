// Small helpers to print a readable log.
import type { CheckResult } from "../src/types.ts";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = c("31"), green = c("32"), yellow = c("33"), bold = c("1"), dim = c("2"), cyan = c("36");

export const h = (s: string) => console.log(`\n${bold(cyan(`== ${s} `.padEnd(78, "=")))}`);
export const line = (s = "") => console.log(s);
export const verdictColor = (v: string) => (v === "block" ? red : v === "warn" ? yellow : green)(bold(v.toUpperCase()));

export function printCheck(r: CheckResult) {
  const e = r.extraction;
  line(`  vision  : source=${e.source} image_sha256=${e.imageSha256?.slice(0, 16) ?? "-"}… ${e.note ? dim(`(${e.note})`) : ""}`);
  if (e.claims) {
    const cl = e.claims;
    line(`  claims  : asset=${cl.asset} price=$${cl.quoted_price} change=${cl.pct_change}% (${cl.timeframe})${cl.profit_claim_pct != null ? ` "already made"=${cl.profit_claim_pct}%` : ""}`);
    for (const i of cl.embedded_instructions) line(`  ${red("injected")}: "${i}"`);
  }
  if (r.visual.truth) line(`  market  : NEAR/USDT $${r.visual.truth.price.toFixed(3)}, ${r.visual.truth.pctChange >= 0 ? "+" : ""}${r.visual.truth.pctChange.toFixed(2)}% over ${r.visual.truth.timeframe} (fixture)`);
  line(`  visual  : ${r.visual.status.toUpperCase()}`);
  for (const f of r.visual.findings) line(`            - ${f}`);
  const cp = r.counterparty;
  line(`  counterparty: ${cp.account.accountId} age=${cp.accountAgeDays?.toFixed(1) ?? "?"}d txs=${cp.account.txCount} contract=${cp.account.isContract}${cp.account.isContract ? ` codeChangedRecently=${cp.codeChangedRecently}` : ""} prior=${cp.priorInteractions} blocklisted=${cp.blocklisted}`);
  for (const rep of cp.reports) line(`            - report by ${rep.reporter}: "${rep.reason}" evidence sha256=${rep.evidence_hash.slice(0, 16)}… ${rep.evidence_uri}`);
  line(`  jev rules: ${r.decision.rules.join(", ")}`);
  for (const why of r.decision.reasons) line(`            ${why}`);
  line(`  scores  : allow=${r.decision.scores.allow} warn=${r.decision.scores.warn} block=${r.decision.scores.block}`);
  line(`  VERDICT : ${verdictColor(r.decision.verdict)}`);
}
