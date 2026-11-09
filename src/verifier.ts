// The check service the agent asks BEFORE sending funds or calling a contract.

import type { CheckResult, PaymentIntent, PolicyLimits, SignedTicket } from "./types.ts";
import type { VisionExtractor } from "./extract.ts";
import { verifyClaims, type MarketSource } from "./market.ts";
import { scoreCounterparty, type BlocklistSource, type ChainDataSource } from "./counterparty.ts";
import { decide, escalateWithModel } from "./jev.ts";
import type { KeyPair } from "./keys.ts";

export interface VerifierDeps {
  extractor: VisionExtractor;
  market: MarketSource;
  chain: ChainDataSource;
  blocklist: BlocklistSource;
  /** Current vault policy (limits, balance, last nonce). */
  vaultState: () => Promise<PolicyLimits & { lastNonce: number }>;
  verifierKey: KeyPair;
  vaultId: string;
  nowMs: () => number;
  ticketTtlMs?: number;
}

export class JevVerifier {
  constructor(private d: VerifierDeps) {}

  async check(intent: PaymentIntent): Promise<CheckResult> {
    const extraction = await this.d.extractor.extract(intent.evidenceImage);
    const visual = await verifyClaims(extraction, this.d.market);
    const counterparty = await scoreCounterparty(intent.agent, intent.receiver, this.d.chain, this.d.blocklist, this.d.nowMs());
    const state = await this.d.vaultState();
    let decision = decide({ intent, visual, cp: counterparty, limits: state });
    decision = await escalateWithModel(decision, { intent: { ...intent, evidenceImage: undefined }, visual, counterparty });

    const result: CheckResult = { decision, extraction, visual, counterparty };
    if (intent.kind !== "return_to_owner" && decision.verdict !== "block") {
      result.ticket = this.signTicket(intent, decision.verdict, state.lastNonce + 1, extraction.imageSha256);
    }
    return result;
  }

  private signTicket(intent: PaymentIntent, verdict: "allow" | "warn", nonce: number, evidence: string | null): SignedTicket {
    const ticket = JSON.stringify({
      v: 1, verdict, vault: this.d.vaultId, agent: intent.agent, receiver: intent.receiver,
      amount: intent.amountYocto, nonce, expires_at_ms: this.d.nowMs() + (this.d.ticketTtlMs ?? 120_000),
      evidence: evidence ?? "0".repeat(64),
    });
    return { ticket, verifierSig: this.d.verifierKey.sign(ticket) };
  }
}
