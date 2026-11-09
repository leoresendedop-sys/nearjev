// Builds the local demo world: simulated chain, vault contract, agent with a
// function-call key, two reporter agents, and the NearJev service.

import { resolve } from "node:path";
import { SimChain, TGAS, GAS_PRICE_YOCTO } from "./chain/sim.ts";
import { VaultContract } from "./chain/vault.ts";
import { DEMO_KEYS } from "./keys.ts";
import { FixtureChainData, SimBlocklist } from "./counterparty.ts";
import { FixtureExtractor } from "./extract.ts";
import { FixtureMarket } from "./market.ts";
import { NearJevVerifier } from "./verifier.ts";
import { GuardedAgentWallet, type HumanApprover } from "./wrapper.ts";
import { FIXTURES, near, readJson, sha256File } from "./util.ts";

export const IDS = {
  owner: "owner-demo.testnet",
  agent: "agent.jev.testnet",
  vault: "vault.jev.testnet",
  reporterA: "agent-a.testnet",
  reporterB: "agent-b.testnet",
};

export const CHART = {
  spoofed: resolve(FIXTURES, "charts", "spoofed-profit.png"),
  honest: resolve(FIXTURES, "charts", "honest-near-24h.png"),
};

export function buildWorld(opts: { askHuman?: HumanApprover; log?: (s: string) => void; fcAllowance?: bigint | null } = {}) {
  const fx = readJson<{ now_ms: number; accounts: Record<string, unknown>; blocklist_reports: Record<string, { reporter: string; reason: string; evidence_uri: string; evidence_file: string }[]> }>(
    resolve(FIXTURES, "accounts.json"),
  );
  const chain = new SimChain(fx.now_ms);
  const k = {
    verifier: DEMO_KEYS.verifier(), human: DEMO_KEYS.human(), agentFc: DEMO_KEYS.agentFc(),
    ownerFull: DEMO_KEYS.ownerFull(), reporterA: DEMO_KEYS.reporterA(), reporterB: DEMO_KEYS.reporterB(),
  };

  chain.createAccount(IDS.owner, near(100));
  chain.addKeyGenesis(IDS.owner, k.ownerFull.publicKeyHex, { kind: "FullAccess" });

  chain.createAccount(IDS.vault, near(20));
  chain.deploy(IDS.vault, new VaultContract({
    owner: IDS.owner, agent: IDS.agent, verifierPkHex: k.verifier.publicKeyHex, humanPkHex: k.human.publicKeyHex,
    perTxLimit: near(5), dailyLimit: near(8), blockThreshold: 2,
  }));

  // The agent account holds ONLY a function-call key scoped to the vault.
  chain.createAccount(IDS.agent, near(1));
  chain.addKeyGenesis(IDS.agent, k.agentFc.publicKeyHex, {
    kind: "FunctionCall", receiverId: IDS.vault, methodNames: ["pay", "return_to_owner"],
    allowance: opts.fcAllowance === undefined ? 250n * TGAS * GAS_PRICE_YOCTO : opts.fcAllowance,
  });

  // Other agents that share the blocklist.
  for (const [id, key] of [[IDS.reporterA, k.reporterA], [IDS.reporterB, k.reporterB]] as const) {
    chain.createAccount(id, near(1));
    chain.addKeyGenesis(id, key.publicKeyHex, { kind: "FullAccess" });
    chain.send(chain.signTx(IDS.owner, k.ownerFull, IDS.vault, [{ type: "FunctionCall", methodName: "add_reporter", args: { reporter: id }, gas: 10n * TGAS, deposit: 0n }]));
  }
  // Seed the shared blocklist through real report transactions with evidence hashes.
  for (const [target, reps] of Object.entries(fx.blocklist_reports)) {
    for (const r of reps) {
      const key = r.reporter === IDS.reporterA ? k.reporterA : k.reporterB;
      chain.send(chain.signTx(r.reporter, key, IDS.vault, [{
        type: "FunctionCall", methodName: "report", gas: 10n * TGAS, deposit: 0n,
        args: { target, reason: r.reason, evidence_hash: sha256File(resolve(FIXTURES, r.evidence_file)), evidence_uri: r.evidence_uri },
      }]));
    }
  }

  // Counterparty accounts from the fixture (balances are illustrative).
  for (const id of Object.keys(fx.accounts)) if (!chain.has(id)) chain.createAccount(id, near(1));

  const verifier = new NearJevVerifier({
    extractor: new FixtureExtractor(),
    market: new FixtureMarket(),
    chain: new FixtureChainData(chain),
    blocklist: new SimBlocklist(chain, IDS.vault),
    vaultState: async () => {
      const p = chain.view(IDS.vault, "get_policy") as any;
      return { perTxYocto: BigInt(p.per_tx_limit), dailyYocto: BigInt(p.daily_limit), vaultBalanceYocto: chain.balance(IDS.vault), lastNonce: p.last_nonce };
    },
    verifierKey: k.verifier,
    vaultId: IDS.vault,
    nowMs: () => chain.nowMs,
  });

  const wallet = new GuardedAgentWallet({
    chain, agentId: IDS.agent, fcKey: k.agentFc, vaultId: IDS.vault, verifier,
    askHuman: opts.askHuman, humanKey: k.human, log: opts.log,
  });

  return { chain, keys: k, verifier, wallet };
}
