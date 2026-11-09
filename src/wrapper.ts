// Agent-side signing gate.
//
//  * block → refuse to sign. Nothing leaves the agent.
//  * warn  → ask a human. Without approval (CLI: --approve-warn) nothing is signed.
//            With approval, the human's key co-signs the ticket; the vault
//            enforces that co-signature on-chain.
//  * allow → sign ONE FunctionCall to the vault with the function-call key.
//
// The wallet refuses to start with anything but a function-call key scoped to
// the vault contract.

import type { KeyPair } from "./keys.ts";
import type { SimChain, Outcome, SignedTransaction } from "./chain/sim.ts";
import { TGAS } from "./chain/sim.ts";
import type { JevVerifier } from "./verifier.ts";
import type { CheckResult, PaymentIntent } from "./types.ts";

export type HumanApprover = (r: CheckResult, intent: PaymentIntent) => Promise<boolean>;

export interface GuardResult {
  status: "signed" | "refused_block" | "refused_needs_human" | "chain_rejected";
  check: CheckResult;
  outcome?: Outcome;
  signed?: SignedTransaction;
}

export class GuardedAgentWallet {
  /** Every transaction this wallet signed (tests assert on this). */
  readonly signatures: SignedTransaction[] = [];

  constructor(
    private o: {
      chain: SimChain;
      agentId: string;
      fcKey: KeyPair;
      vaultId: string;
      verifier: JevVerifier;
      /** Called on WARN. Default: never approve (the human was not asked). */
      askHuman?: HumanApprover;
      /** Human owner co-sign key — lives with the human, used only after approval. */
      humanKey?: KeyPair;
      log?: (s: string) => void;
    },
  ) {
    const ak = o.chain.accessKey(o.agentId, o.fcKey.publicKeyHex);
    if (!ak) throw new Error("agent key not found on chain");
    if (ak.permission.kind !== "FunctionCall") throw new Error("refusing to run: agent key is FULL ACCESS; use a function-call key scoped to the vault");
    if (ak.permission.receiverId !== o.vaultId) throw new Error(`refusing to run: function-call key is scoped to ${ak.permission.receiverId}, not the vault ${o.vaultId}`);
  }

  private log(s: string) { this.o.log?.(s); }

  async pay(intent: PaymentIntent): Promise<GuardResult> {
    const check = await this.o.verifier.check(intent);
    const v = check.decision.verdict;

    if (v === "block") {
      this.log(`wallet: verdict BLOCK → refusing to sign. No transaction created.`);
      return { status: "refused_block", check };
    }

    let humanSig: string | null = null;
    if (v === "warn" && intent.kind !== "return_to_owner") {
      const approved = this.o.askHuman ? await this.o.askHuman(check, intent) : false;
      if (!approved) {
        this.log(`wallet: verdict WARN → a human would be asked to approve. Not approved → NOT signing.`);
        return { status: "refused_needs_human", check };
      }
      if (!this.o.humanKey) throw new Error("warn approved but no human co-sign key configured");
      humanSig = this.o.humanKey.sign(check.ticket!.ticket);
      this.log(`wallet: verdict WARN → human approved; ticket co-signed by the human key.`);
    }

    const action =
      intent.kind === "return_to_owner"
        ? { type: "FunctionCall" as const, methodName: "return_to_owner", args: { amount: intent.amountYocto }, gas: 30n * TGAS, deposit: 0n }
        : {
            type: "FunctionCall" as const, methodName: "pay",
            args: { ticket: check.ticket!.ticket, verifier_sig: check.ticket!.verifierSig, human_sig: humanSig },
            gas: 50n * TGAS, deposit: 0n,
          };
    const signed = this.o.chain.signTx(this.o.agentId, this.o.fcKey, this.o.vaultId, [action]);
    this.signatures.push(signed);
    this.log(`wallet: signing FunctionCall(${action.methodName}) → ${this.o.vaultId} with FUNCTION-CALL key ${this.o.fcKey.publicKeyHex.slice(0, 12)}…`);
    const outcome = this.o.chain.send(signed);
    return { status: outcome.status === "SuccessValue" ? "signed" : "chain_rejected", check, outcome, signed };
  }
}
