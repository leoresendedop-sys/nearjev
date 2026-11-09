// Shared helpers for the testnet deploy + live proof.
// SECRETS: every private key lives in ../.near-testnet/ (gitignored). Nothing
// here prints a private key.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, Connection, KeyPair, keyStores } from "near-api-js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
export const SECRET_DIR = resolve(ROOT, ".near-testnet");
export const STATE = resolve(SECRET_DIR, "state.json");
export const RPC = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
export const FAUCET = process.env.NEAR_FAUCET_URL ?? "https://helper.nearprotocol.com/account";
export const EXPLORER = "https://testnet.nearblocks.io";
export const txUrl = (h: string) => `${EXPLORER}/txns/${h}`;
export const accUrl = (a: string) => `${EXPLORER}/address/${a}`;
export const yocto = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;

export interface State {
  network: "testnet";
  suffix: string;
  accounts: { owner: string; vault: string; agent: string; shop: string; badPayee: string; reporter: string };
  keys: { ownerFull: string; agentFc: string; verifierSeedHex: string; humanSeedHex: string };
  txs: Record<string, string>;
  deployed?: boolean;
}

export function loadState(): State {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8"));
  const suffix = randomBytes(3).toString("hex");
  const owner = `nearjev-${suffix}.testnet`;
  const s: State = {
    network: "testnet",
    suffix,
    accounts: {
      owner,
      vault: `vault.${owner}`,
      agent: `agent.${owner}`,
      shop: `shop.${owner}`,
      badPayee: `payout-unlock.${owner}`,
      reporter: `reporter-a.${owner}`,
    },
    keys: {
      ownerFull: KeyPair.fromRandom("ed25519").toString(),
      agentFc: KeyPair.fromRandom("ed25519").toString(),
      verifierSeedHex: randomBytes(32).toString("hex"),
      humanSeedHex: randomBytes(32).toString("hex"),
    },
    txs: {},
  };
  saveState(s);
  return s;
}

export function saveState(s: State) {
  mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
  chmodSync(STATE, 0o600);
}

export async function accountFor(id: string, secretKey: string) {
  const keyStore = new keyStores.InMemoryKeyStore();
  await keyStore.setKey("testnet", id, KeyPair.fromString(secretKey as any));
  const connection = Connection.fromConfig({
    networkId: "testnet",
    provider: { type: "JsonRpcProvider", args: { url: RPC } },
    signer: { type: "InMemorySigner", keyStore },
  });
  return new Account(connection, id);
}

export async function rpc(method: string, params: unknown) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "nearjev", method, params }) });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

export async function view(contract: string, method: string, args: object = {}) {
  const res = await rpc("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(res.result).toString());
}

export async function accountExists(id: string) {
  try { await rpc("query", { request_type: "view_account", finality: "final", account_id: id }); return true; } catch { return false; }
}

/** Short failure summary from a FinalExecutionOutcome. */
export function failureOf(o: any): string | null {
  const st = o?.status;
  if (st && typeof st === "object" && "Failure" in st) {
    const s = JSON.stringify(st.Failure);
    const m = s.match(/Smart contract panicked: ([^"\\]+)/);
    return m ? `Smart contract panicked: ${m[1]}` : s.slice(0, 200);
  }
  return null;
}
