// TypeScript mirror of contract/src/lib.rs (Jev Policy Vault) for the local
// simulator. Same methods, same rules, same panic messages. The Rust contract
// is the deployable artifact; this mirror lets judges run everything with Node.

import { verifySig } from "../keys.ts";
import type { BlocklistReport } from "../types.ts";
import type { CallContext, SimContract } from "./sim.ts";

const DAY = 86_400_000;

export interface VaultInit {
  owner: string;
  agent: string;
  verifierPkHex: string;
  humanPkHex: string;
  perTxLimit: bigint;
  dailyLimit: bigint;
  blockThreshold: number;
}

interface Ticket {
  v: number; verdict: string; vault: string; agent: string; receiver: string;
  amount: string; nonce: number; expires_at_ms: number; evidence: string;
}

const require_ = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

export class VaultContract implements SimContract {
  private spentDay = 0;
  private spentToday = 0n;
  private lastNonce = 0;
  private reporters = new Set<string>();
  private reports = new Map<string, BlocklistReport[]>();
  private confirmed = new Set<string>();
  constructor(private s: VaultInit) {}

  call(method: string, args: Record<string, any>, ctx: CallContext): unknown {
    switch (method) {
      case "deposit": require_(ctx.predecessor === this.s.owner, "only owner can fund"); return;
      case "pay": return this.pay(args.ticket, args.verifier_sig, args.human_sig ?? null, ctx);
      case "return_to_owner": {
        require_(ctx.predecessor === this.s.agent || ctx.predecessor === this.s.owner, "only agent or owner");
        ctx.log(`JEV_RETURN amount=${args.amount}`);
        ctx.transfer(this.s.owner, BigInt(args.amount));
        return;
      }
      case "add_reporter": this.owner(ctx); this.reporters.add(args.reporter); return;
      case "report": return this.report(args as any, ctx);
      case "confirm_block": this.owner(ctx); this.confirmed.add(args.target); return;
      case "clear_block": this.owner(ctx); this.confirmed.delete(args.target); this.reports.delete(args.target); return;
      default: throw new Error(`MethodNotFound: ${method}`);
    }
  }

  view(method: string, args: Record<string, any>, ctx: { blockTimestampMs: number }): unknown {
    switch (method) {
      case "is_blocked": return this.isBlocked(args.target);
      case "get_reports": return this.reports.get(args.target) ?? [];
      case "get_policy": {
        const today = Math.floor(ctx.blockTimestampMs / DAY);
        return {
          owner: this.s.owner, agent: this.s.agent, verifier_pk: this.s.verifierPkHex, human_pk: this.s.humanPkHex,
          per_tx_limit: this.s.perTxLimit.toString(), daily_limit: this.s.dailyLimit.toString(),
          spent_today: (today === this.spentDay ? this.spentToday : 0n).toString(),
          last_nonce: this.lastNonce, block_threshold: this.s.blockThreshold,
        };
      }
      default: throw new Error(`MethodNotFound: ${method}`);
    }
  }

  private pay(ticketStr: string, verifierSig: string, humanSig: string | null, ctx: CallContext) {
    require_(ctx.predecessor === this.s.agent, "only the registered agent can pay");
    let t: Ticket;
    try { t = JSON.parse(ticketStr); } catch { throw new Error("malformed ticket"); }
    require_(t.v === 1, "unsupported ticket version");
    require_(t.vault === ctx.currentAccount, "ticket is for another vault");
    require_(t.agent === ctx.predecessor, "ticket is for another agent");
    require_(t.nonce > this.lastNonce, "ticket nonce already used");
    require_(t.expires_at_ms >= ctx.blockTimestampMs, "ticket expired");
    require_(verifySig(this.s.verifierPkHex, ticketStr, verifierSig), "invalid verifier signature");
    if (t.verdict === "block") throw new Error("verdict is BLOCK: refusing to pay");
    if (t.verdict === "warn") {
      require_(!!humanSig, "verdict is WARN: human co-signature required");
      require_(verifySig(this.s.humanPkHex, ticketStr, humanSig!), "invalid human signature");
    } else require_(t.verdict === "allow", "bad verdict");
    require_(!this.isBlocked(t.receiver), "receiver is on the shared blocklist");

    const today = Math.floor(ctx.blockTimestampMs / DAY);
    if (today !== this.spentDay) { this.spentDay = today; this.spentToday = 0n; }
    const amount = BigInt(t.amount);
    require_(amount > 0n, "amount must be > 0");
    require_(amount <= this.s.perTxLimit, "amount exceeds per-transaction limit");
    require_(this.spentToday + amount <= this.s.dailyLimit, "amount exceeds daily limit");
    this.spentToday += amount;
    this.lastNonce = t.nonce;
    ctx.log(`JEV_PAY verdict=${t.verdict} receiver=${t.receiver} amount=${t.amount} nonce=${t.nonce}`);
    ctx.transfer(t.receiver, amount);
  }

  private report(a: { target: string; reason: string; evidence_hash: string; evidence_uri: string }, ctx: CallContext) {
    require_(ctx.predecessor === this.s.owner || this.reporters.has(ctx.predecessor), "reporter not registered");
    require_(/^[0-9a-f]{64}$/.test(a.evidence_hash), "evidence_hash must be sha256 hex");
    require_(a.reason.length <= 280 && a.evidence_uri.length <= 512, "report too long");
    const list = (this.reports.get(a.target) ?? []).filter((r) => r.reporter !== ctx.predecessor);
    list.push({ reporter: ctx.predecessor, reason: a.reason, evidence_hash: a.evidence_hash, evidence_uri: a.evidence_uri, timestamp_ms: ctx.blockTimestampMs });
    this.reports.set(a.target, list);
  }

  private isBlocked(target: string) {
    const n = this.reports.get(target)?.length ?? 0;
    return this.confirmed.has(target) || (this.s.blockThreshold > 0 && n >= this.s.blockThreshold);
  }
  private owner(ctx: CallContext) { require_(ctx.predecessor === this.s.owner, "only owner"); }
}
