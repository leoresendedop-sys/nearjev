// OPTIONAL real-chain test: deploys the compiled Rust vault into a local NEAR
// sandbox (nearcore via near-workspaces), gives the agent ONLY a function-call
// key, and replays the attack. Requires: contract built to wasm (see README).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nw, { type NearAccount, type Worker as WorkerT } from "near-workspaces";
import nearTx from "near-api-js/lib/transaction.js";
const { Worker, KeyPair } = nw;
const { functionCallAccessKey } = nearTx;
import { DEMO_KEYS } from "../src/keys.ts";
import { near as N } from "../src/util.ts";

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, process.env.VAULT_WASM ?? "../contract/res/nearjev_policy_vault.wasm");
const verifier = DEMO_KEYS.verifier();
const human = DEMO_KEYS.human();

let worker: WorkerT;
let vault: NearAccount, agent: NearAccount, owner: NearAccount, shop: NearAccount, drainer: NearAccount, reporter: NearAccount;
let nonce = 0;

const ticket = (verdict: string, receiver: string, near: string) => JSON.stringify({
  v: 1, verdict, vault: vault.accountId, agent: agent.accountId, receiver,
  amount: N(Number(near)).toString(), nonce: ++nonce, expires_at_ms: Date.now() + 10 * 60_000, evidence: "ab".repeat(32),
});
const balance = async (a: NearAccount) => BigInt((await a.balance()).total.toString());

before(async () => {
  assert.ok(existsSync(WASM), `build the contract first: ${WASM}`);
  worker = await Worker.init();
  const root = worker.rootAccount;
  owner = await root.createSubAccount("owner");
  shop = await root.createSubAccount("shop");
  drainer = await root.createSubAccount("payout-unlock");
  reporter = await root.createSubAccount("agent-a");
  vault = await root.createSubAccount("vault", { initialBalance: N(30) });
  agent = await root.createSubAccount("agent");
  await vault.deploy(WASM);
  await vault.call(vault, "new", {
    owner: owner.accountId, agent: agent.accountId,
    verifier_pk_hex: verifier.publicKeyHex, human_pk_hex: human.publicKeyHex,
    per_tx_limit: N(5).toString(), daily_limit: N(8).toString(), block_threshold: 1,
  });
  // Swap the agent's full-access key for ONE function-call key scoped to the vault.
  const fullPk = await agent.getKey();
  const fc = KeyPair.fromRandom("ed25519");
  await agent.batch(agent)
    .addKey(fc.getPublicKey(), functionCallAccessKey(vault.accountId, ["pay", "return_to_owner"], N(1)))
    .deleteKey(fullPk!.getPublicKey())
    .transact();
  await agent.setKey(fc);
  await owner.call(vault, "add_reporter", { reporter: reporter.accountId });
  await reporter.call(vault, "report", { target: drainer.accountId, reason: "fake payout", evidence_hash: "cd".repeat(32), evidence_uri: "ipfs://demo" });
});

after(async () => { await worker?.tearDown().catch(() => {}); });

test("sandbox: agent has only a function-call key", async () => {
  const rpcAddr = (worker as any).config.rpcAddr as string;
  const r = await fetch(rpcAddr, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key_list", finality: "final", account_id: agent.accountId } }) });
  const keys = ((await r.json()) as any).result.keys;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].access_key.permission.FunctionCall.receiver_id, vault.accountId);
});

test("sandbox: ALLOW ticket pays through the vault with the function-call key", async () => {
  const before = await balance(shop);
  const t = ticket("allow", shop.accountId, "1");
  await agent.call(vault, "pay", { ticket: t, verifier_sig: verifier.sign(t), human_sig: null }, { gas: 50_000_000_000_000n });
  assert.ok((await balance(shop)) - before >= N(1) - 10n ** 21n);
});

test("sandbox: BLOCK ticket, forged ticket, blocklisted receiver and WARN-without-human are refused", async () => {
  const b = ticket("block", shop.accountId, "1");
  await assert.rejects(agent.call(vault, "pay", { ticket: b, verifier_sig: verifier.sign(b), human_sig: null }, { gas: 50_000_000_000_000n }), /BLOCK/);
  const f = ticket("allow", drainer.accountId, "1");
  await assert.rejects(agent.call(vault, "pay", { ticket: f, verifier_sig: human.sign(f), human_sig: null }, { gas: 50_000_000_000_000n }), /invalid verifier signature/);
  const bl = ticket("allow", drainer.accountId, "1");
  await assert.rejects(agent.call(vault, "pay", { ticket: bl, verifier_sig: verifier.sign(bl), human_sig: null }, { gas: 50_000_000_000_000n }), /shared blocklist/);
  const w = ticket("warn", shop.accountId, "1");
  await assert.rejects(agent.call(vault, "pay", { ticket: w, verifier_sig: verifier.sign(w), human_sig: null }, { gas: 50_000_000_000_000n }), /human co-signature/);
  const w2 = ticket("warn", shop.accountId, "1");
  await agent.call(vault, "pay", { ticket: w2, verifier_sig: verifier.sign(w2), human_sig: human.sign(w2) }, { gas: 50_000_000_000_000n });
});

test("sandbox: function-call key cannot transfer NEAR directly or call another contract", async () => {
  await assert.rejects(agent.transfer(drainer, N(0.5)));
  await assert.rejects(agent.call(owner, "anything", {}));
});
