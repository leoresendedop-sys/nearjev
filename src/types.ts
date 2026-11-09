// Shared types for Jev Verify.

export type Verdict = "allow" | "warn" | "block";

/** What the agent wants to do. Amounts are yoctoNEAR strings. */
export interface PaymentIntent {
  agent: string;
  receiver: string;
  amountYocto: string;
  /** "pay" increases exposure / sends funds; "return_to_owner" decreases risk. */
  kind: "pay" | "contract_call" | "return_to_owner";
  /** Contract method if kind === "contract_call". */
  method?: string;
  /** Free-text reason the agent gives (may be prompt-injected!). */
  memo?: string;
  /** Path to the chart/screenshot that convinced the agent, if any. */
  evidenceImage?: string;
}

/** Structured claims a vision model extracts from a chart image. */
export interface ChartClaims {
  asset: string | null;
  quoted_price: number | null;
  pct_change: number | null;
  timeframe: string | null;
  /** "your agent already made X%" style claims. */
  profit_claim_pct: number | null;
  as_of: string | null;
  /** Text in the image that tries to instruct the agent (prompt injection). */
  embedded_instructions: string[];
}

export interface Extraction {
  source: "fixture" | "live" | "none";
  imageSha256: string | null;
  claims: ChartClaims | null;
  note?: string;
}

export type VisualStatus = "match" | "mismatch" | "unverifiable" | "none";

export interface VisualCheck {
  status: VisualStatus;
  findings: string[];
  truth?: { price: number; pctChange: number; timeframe: string; asOf: number };
  injectionDetected: boolean;
}

export interface AccountInfo {
  accountId: string;
  exists: boolean;
  createdAtMs: number | null;
  txCount: number;
  isContract: boolean;
  codeHash: string | null;
  codeChangedAtMs: number | null;
}

export interface BlocklistReport {
  reporter: string;
  reason: string;
  evidence_hash: string;
  evidence_uri: string;
  timestamp_ms: number;
}

export interface CounterpartySignals {
  account: AccountInfo;
  accountAgeDays: number | null;
  isNewAccount: boolean;
  lowActivity: boolean;
  codeChangedRecently: boolean;
  priorInteractions: number;
  blocklisted: boolean;
  reports: BlocklistReport[];
}

export interface PolicyLimits {
  perTxYocto: bigint;
  dailyYocto: bigint;
  vaultBalanceYocto: bigint;
}

export interface Decision {
  verdict: Verdict;
  reasons: string[];
  /** Rule ids that fired, in order (machine-readable audit trail). */
  rules: string[];
  /** Bounded "Jev" scores over the three typed choices. */
  scores: Record<Verdict, number>;
}

export interface CheckResult {
  decision: Decision;
  extraction: Extraction;
  visual: VisualCheck;
  counterparty: CounterpartySignals;
  /** Signed ticket, only for allow/warn on fund-moving intents. */
  ticket?: SignedTicket;
}

export interface SignedTicket {
  ticket: string; // exact JSON string that was signed
  verifierSig: string; // hex ed25519
}
