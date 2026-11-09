// Counterparty signals: account age/activity, contract + recent code change,
// prior interactions with this agent, and the shared on-chain blocklist.

import { resolve } from "node:path";
import type { AccountInfo, BlocklistReport, CounterpartySignals } from "./types.ts";
import { DAY_MS, FIXTURES, readJson } from "./util.ts";
import type { SimChain } from "./chain/sim.ts";

export interface ChainDataSource {
  getAccount(accountId: string): Promise<AccountInfo>;
  priorInteractions(agent: string, receiver: string): Promise<number>;
}

export interface BlocklistSource {
  isBlocked(accountId: string): Promise<boolean>;
  reports(accountId: string): Promise<BlocklistReport[]>;
}

export const THRESHOLDS = { newAccountDays: 7, lowActivityTx: 10, codeChangeRecentHours: 72 };

interface FixtureFile {
  now_ms: number;
  accounts: Record<string, { created_days_ago: number; tx_count: number; is_contract: boolean; code_changed_days_ago?: number }>;
  interactions: Record<string, Record<string, number>>;
}

/** Fixture chain data + live interaction history from the simulator. */
export class FixtureChainData implements ChainDataSource {
  readonly file = readJson<FixtureFile>(resolve(FIXTURES, "accounts.json"));
  constructor(private sim?: SimChain) {}
  async getAccount(id: string): Promise<AccountInfo> {
    const a = this.file.accounts[id];
    if (!a) return { accountId: id, exists: false, createdAtMs: null, txCount: 0, isContract: false, codeHash: null, codeChangedAtMs: null };
    const now = this.file.now_ms;
    return {
      accountId: id, exists: true,
      createdAtMs: now - a.created_days_ago * DAY_MS,
      txCount: a.tx_count,
      isContract: a.is_contract,
      codeHash: a.is_contract ? `fixture-code-${id}` : null,
      codeChangedAtMs: a.code_changed_days_ago != null ? now - a.code_changed_days_ago * DAY_MS : null,
    };
  }
  async priorInteractions(agent: string, receiver: string) {
    const base = this.file.interactions[agent]?.[receiver] ?? 0;
    // Successful vault payouts in this session count as interactions too.
    const live = this.sim?.outcomes.filter((o) => o.status === "SuccessValue" && o.signerId === agent && o.transfers.some((t) => t.to === receiver)).length ?? 0;
    return base + live;
  }
}

/** Reads the shared blocklist from the vault contract running in the simulator. */
export class SimBlocklist implements BlocklistSource {
  constructor(private sim: SimChain, private vaultId: string) {}
  async isBlocked(id: string) { return this.sim.view(this.vaultId, "is_blocked", { target: id }) as boolean; }
  async reports(id: string) { return this.sim.view(this.vaultId, "get_reports", { target: id }) as BlocklistReport[]; }
}

// ----------------------------------------------------------------- live adapters
// Not exercised by tests (no network in CI). See README "Data sources".

async function rpc(method: string, params: unknown, url = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org") {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "jev", method, params }) });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

const EMPTY_CODE_HASH = "11111111111111111111111111111111";

/**
 * NEAR RPC (view_account → code_hash) + an indexer for history.
 * Indexer paths follow the public Nearblocks API layout; verify against its
 * current docs before relying on them.
 */
export class NearRpcChainData implements ChainDataSource {
  constructor(private indexer = process.env.NEARBLOCKS_API ?? "https://api-testnet.nearblocks.io") {}
  async getAccount(id: string): Promise<AccountInfo> {
    let codeHash: string | null = null;
    try {
      const v = await rpc("query", { request_type: "view_account", finality: "final", account_id: id });
      codeHash = v.code_hash === EMPTY_CODE_HASH ? null : v.code_hash;
    } catch {
      return { accountId: id, exists: false, createdAtMs: null, txCount: 0, isContract: false, codeHash: null, codeChangedAtMs: null };
    }
    const info = await this.get(`/v1/account/${id}`);
    const deployments = codeHash ? await this.get(`/v1/account/${id}/contract/deployments`) : null;
    const created = info?.account?.[0]?.created?.block_timestamp;
    const lastDeploy = deployments?.deployments?.[0]?.block_timestamp;
    const count = await this.get(`/v1/account/${id}/txns/count`);
    return {
      accountId: id, exists: true,
      createdAtMs: created ? Number(BigInt(created) / 1_000_000n) : null,
      txCount: Number(count?.txns?.[0]?.count ?? 0),
      isContract: codeHash !== null, codeHash,
      codeChangedAtMs: lastDeploy ? Number(BigInt(lastDeploy) / 1_000_000n) : null,
    };
  }
  async priorInteractions(agent: string, receiver: string) {
    const j = await this.get(`/v1/account/${agent}/txns/count?to=${receiver}`);
    return Number(j?.txns?.[0]?.count ?? 0);
  }
  private async get(path: string) {
    try { const r = await fetch(this.indexer + path); return r.ok ? ((await r.json()) as any) : null; } catch { return null; }
  }
}

/** Shared blocklist read straight from the deployed vault via RPC call_function. */
export class RpcBlocklist implements BlocklistSource {
  constructor(private vaultId: string) {}
  private async view(method: string, args: object) {
    const res = await rpc("query", { request_type: "call_function", finality: "final", account_id: this.vaultId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
    return JSON.parse(Buffer.from(res.result).toString());
  }
  async isBlocked(id: string) { return (await this.view("is_blocked", { target: id })) as boolean; }
  async reports(id: string) { return (await this.view("get_reports", { target: id })) as BlocklistReport[]; }
}

// ------------------------------------------------------------------- scoring

export async function scoreCounterparty(
  agent: string, receiver: string, chain: ChainDataSource, blocklist: BlocklistSource, nowMs: number,
): Promise<CounterpartySignals> {
  const [account, priorInteractions, blocklisted, reports] = await Promise.all([
    chain.getAccount(receiver), chain.priorInteractions(agent, receiver), blocklist.isBlocked(receiver), blocklist.reports(receiver),
  ]);
  const accountAgeDays = account.createdAtMs != null ? (nowMs - account.createdAtMs) / DAY_MS : null;
  return {
    account,
    accountAgeDays,
    isNewAccount: !account.exists || (accountAgeDays != null && accountAgeDays < THRESHOLDS.newAccountDays),
    lowActivity: account.txCount < THRESHOLDS.lowActivityTx,
    codeChangedRecently: account.codeChangedAtMs != null && nowMs - account.codeChangedAtMs < THRESHOLDS.codeChangeRecentHours * 3_600_000,
    priorInteractions,
    blocklisted,
    reports,
  };
}
