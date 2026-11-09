// The Jev step: a bounded decision over exactly three typed choices.
//
// The deterministic policy below is the floor. An optional model endpoint
// (JEV_ENDPOINT) may ESCALATE allow→warn→block but can never relax it — the
// same "veto" spirit as Argon-proposes / Jev-vetoes: refusing or reducing risk
// is always allowed; sending funds needs the verifier's agreement.

import type { CounterpartySignals, Decision, PaymentIntent, PolicyLimits, Verdict, VisualCheck } from "./types.ts";
import { fmtNear } from "./util.ts";

export const SEVERITY: Record<Verdict, number> = { allow: 0, warn: 1, block: 2 };
export const maxVerdict = (a: Verdict, b: Verdict): Verdict => (SEVERITY[a] >= SEVERITY[b] ? a : b);

/** A payment is "drain-like" if it takes at least this share of the vault. */
export const DRAIN_SHARE = 0.5;

export interface JevInput {
  intent: PaymentIntent;
  visual: VisualCheck;
  cp: CounterpartySignals;
  limits: PolicyLimits;
}

export function decide({ intent, visual, cp, limits }: JevInput): Decision {
  const reasons: string[] = [];
  const rules: string[] = [];
  let verdict: Verdict = "allow";
  const fire = (id: string, v: Verdict, why: string) => { rules.push(id); reasons.push(`[${v.toUpperCase()}] ${why}`); verdict = maxVerdict(verdict, v); };

  // R0 — decreasing risk is always allowed.
  if (intent.kind === "return_to_owner") {
    fire("R0_decrease_risk", "allow", "returning funds to the owner reduces exposure: always allowed");
    return finish(verdict, reasons, rules);
  }

  const amount = BigInt(intent.amountYocto);
  const mismatch = visual.status === "mismatch";
  const visualDoubt = mismatch || visual.status === "unverifiable";
  const unknownCp = cp.priorInteractions === 0;
  const drainLike = limits.vaultBalanceYocto > 0n && Number(amount) / Number(limits.vaultBalanceYocto) >= DRAIN_SHARE;

  // R1 — shared blocklist.
  if (cp.blocklisted) {
    const who = cp.reports.map((r) => `${r.reporter}: "${r.reason}" (evidence ${r.evidence_hash.slice(0, 12)}…)`).join("; ");
    fire("R1_blocklist", "block", `receiver ${intent.receiver} is on the shared blocklist (${cp.reports.length} report(s): ${who})`);
  }
  // R2 — hard spend limit (the vault would refuse anyway; never sign).
  if (amount > limits.perTxYocto) fire("R2_per_tx_limit", "block", `amount ${fmtNear(amount)} exceeds per-tx limit ${fmtNear(limits.perTxYocto)}`);

  // R3 — visual claim verification (the differentiator).
  if (mismatch) {
    const detail = visual.findings.filter((f) => !f.includes("matches")).join("; ");
    if (drainLike || unknownCp) {
      fire("R3b_visual_mismatch_plus_risky_payment", "block",
        `chart claims disagree with market truth (${detail}) AND the payment is ${[drainLike && "drain-like", unknownCp && "to an unknown counterparty"].filter(Boolean).join(" and ")}`);
    } else {
      fire("R3_visual_mismatch", "warn", `chart claims disagree with market truth (${detail})`);
    }
  } else if (visual.status === "unverifiable") {
    fire("R3u_visual_unverifiable", "warn", `chart could not be verified: ${visual.findings.join("; ")}`);
  }

  // R4 — fresh / thin account.
  if (cp.isNewAccount || cp.lowActivity) {
    const why = !cp.account.exists ? "receiver account does not exist yet"
      : `receiver is ${cp.accountAgeDays?.toFixed(1)} days old with ${cp.account.txCount} txs`;
    fire("R4_new_or_thin_account", mismatch ? "block" : "warn", mismatch ? `${why}, stacked with a visual mismatch` : why);
  }
  // R5 — contract code changed recently.
  if (cp.account.isContract && cp.codeChangedRecently) {
    fire("R5_code_changed_recently", mismatch ? "block" : "warn",
      `receiver contract code changed recently${mismatch ? ", stacked with a visual mismatch" : ""}`);
  }
  // R6 — first payment to this receiver.
  if (unknownCp && !cp.blocklisted && !mismatch) {
    if (cp.account.isContract) fire("R6_first_call_new_contract", "warn", `first interaction with contract ${intent.receiver}${visualDoubt ? " while the chart is in doubt" : ""}`);
    else fire("R6_first_payment", "warn", `first payment from this agent to ${intent.receiver}: a human approves new receivers once`);
  }
  // R7 — large share of the vault.
  if (drainLike && !mismatch) fire("R7_drain_like", "warn", `payment is ≥${DRAIN_SHARE * 100}% of the vault balance (${fmtNear(limits.vaultBalanceYocto)})`);

  if (rules.length === 0) {
    const vis = visual.status === "match" ? "chart claims match market data" : "no chart attached";
    fire("R8_ok", "allow", `${vis}; known counterparty (${cp.priorInteractions} prior interactions); not blocklisted; within limits`);
  }
  return finish(verdict, reasons, rules);
}

function finish(verdict: Verdict, reasons: string[], rules: string[]): Decision {
  // Bounded, deterministic scores over the three typed choices (for display/audit).
  const risk = reasons.reduce((s, r) => s + (r.startsWith("[BLOCK]") ? 3 : r.startsWith("[WARN]") ? 1 : 0), 0);
  const raw = { allow: Math.exp(-risk), warn: Math.exp(-Math.abs(risk - 1.5)), block: Math.exp(-Math.max(0, 3 - risk)) };
  const z = raw.allow + raw.warn + raw.block;
  const scores = { allow: +(raw.allow / z).toFixed(3), warn: +(raw.warn / z).toFixed(3), block: +(raw.block / z).toFixed(3) };
  return { verdict, reasons, rules, scores };
}

/**
 * Optional model hook. POSTs the typed features to JEV_ENDPOINT and expects
 * {"verdict":"allow"|"warn"|"block"}. The result can only make things stricter.
 */
export async function escalateWithModel(d: Decision, features: object): Promise<Decision> {
  const url = process.env.JEV_ENDPOINT;
  if (!url) return d;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.JEV_API_KEY ? { authorization: `Bearer ${process.env.JEV_API_KEY}` } : {}) },
      body: JSON.stringify({ choices: ["allow", "warn", "block"], features, policy_verdict: d.verdict }),
    });
    const j = (await r.json()) as { verdict?: string };
    const mv = j.verdict as Verdict;
    if (!(mv in SEVERITY) || SEVERITY[mv] <= SEVERITY[d.verdict]) return d;
    return { ...d, verdict: mv, rules: [...d.rules, "M1_model_escalation"], reasons: [...d.reasons, `[${mv.toUpperCase()}] Jev model escalated the verdict`] };
  } catch {
    return d; // model failure never relaxes the policy floor
  }
}
