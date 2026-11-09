// Deploy NearJev to NEAR TESTNET (rerunnable; state + keys in ../.near-testnet/).
//
//   npm run deploy:testnet
//
// 1. Owner account nearjev-<suffix>.testnet is created by the official testnet
//    faucet service (the same one near-cli's sponsor-by-faucet-service uses).
// 2. Owner creates sub-accounts in single batch transactions:
//    vault.*  : create + fund + owner key + deploy wasm + init
//    agent.*  : create + fund + ONE function-call key (vault: pay, return_to_owner).
//               The agent never holds a full-access key, not even temporarily.
//    shop.*, payout-unlock.* : keyless receiver accounts for the demo
//    reporter-a.* : a second "agent" that reports to the shared blocklist
// 3. reporter-a reports payout-unlock.* with an evidence hash (blocklisted).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transactions, KeyPair, utils } from "near-api-js";
import { keyFromSeed } from "../src/keys.ts";
import { sha256File } from "../src/util.ts";
import { FAUCET, ROOT, accUrl, accountExists, accountFor, failureOf, loadState, saveState, txUrl, view, yocto } from "./common.ts";

const s = loadState();
const A = s.accounts;
const ownerKp = KeyPair.fromString(s.keys.ownerFull as any);
const agentKp = KeyPair.fromString(s.keys.agentFc as any);
const verifier = keyFromSeed(Buffer.from(s.keys.verifierSeedHex, "hex"), "testnet verifier");
const human = keyFromSeed(Buffer.from(s.keys.humanSeedHex, "hex"), "testnet human co-sign");
const TGAS = 10n ** 12n;
const log = (m: string) => console.log(m);

async function step(name: string, fn: () => Promise<any>) {
  if (s.txs[name]) { log(`✓ ${name} (already done) ${txUrl(s.txs[name])}`); return; }
  const out = await fn();
  const hash = out?.transaction?.hash ?? out?.transaction_outcome?.id;
  const fail = failureOf(out);
  if (fail) throw new Error(`${name} failed: ${fail} ${hash ? txUrl(hash) : ""}`);
  s.txs[name] = hash;
  saveState(s);
  log(`✓ ${name} ${txUrl(hash)}`);
}

// 1. Faucet-sponsored owner account.
if (!(await accountExists(A.owner))) {
  log(`Requesting ${A.owner} from the testnet faucet service…`);
  const r = await fetch(FAUCET, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: A.owner, newAccountPublicKey: ownerKp.getPublicKey().toString() }) });
  const body = await r.text();
  if (r.status >= 400) throw new Error(`faucet HTTP ${r.status}: ${body.slice(0, 300)}`);
  try { const j = JSON.parse(body); const h = j?.final_execution_outcome?.transaction_outcome?.id ?? j?.transaction_outcome?.id; if (h) { s.txs.faucet_create_owner = h; saveState(s); } } catch {}
  for (let i = 0; i < 20 && !(await accountExists(A.owner)); i++) await new Promise((r) => setTimeout(r, 1500));
  if (!(await accountExists(A.owner))) throw new Error("owner account did not appear after faucet call");
}
log(`owner ${A.owner} ${accUrl(A.owner)}`);
const owner = await accountFor(A.owner, s.keys.ownerFull);
const opts = { returnError: true } as any;

// 2. Vault: create + fund + key + deploy + init, in one transaction.
const wasm = readFileSync(resolve(ROOT, "contract/res/nearjev_policy_vault.wasm"));
await step("create_deploy_init_vault", () => owner.signAndSendTransaction({
  receiverId: A.vault,
  actions: [
    transactions.createAccount(),
    transactions.transfer(yocto(3.5)),
    transactions.addKey(ownerKp.getPublicKey(), transactions.fullAccessKey()),
    transactions.deployContract(wasm),
    transactions.functionCall("new", {
      owner: A.owner, agent: A.agent, verifier_pk_hex: verifier.publicKeyHex, human_pk_hex: human.publicKeyHex,
      per_tx_limit: yocto(0.5).toString(), daily_limit: yocto(1).toString(), block_threshold: 1,
    }, 50n * TGAS, 0n),
  ],
  ...opts,
}));

// Agent: ONLY a function-call key scoped to the vault.
await step("create_agent_fc_key_only", () => owner.signAndSendTransaction({
  receiverId: A.agent,
  actions: [
    transactions.createAccount(),
    transactions.transfer(yocto(0.3)),
    transactions.addKey(agentKp.getPublicKey(), transactions.functionCallAccessKey(A.vault, ["pay", "return_to_owner"], yocto(0.25))),
  ],
  ...opts,
}));

for (const [name, id] of [["create_shop", A.shop], ["create_bad_payee", A.badPayee]] as const) {
  await step(name, () => owner.signAndSendTransaction({ receiverId: id, actions: [transactions.createAccount(), transactions.transfer(yocto(0.05))], ...opts }));
}
await step("create_reporter", () => owner.signAndSendTransaction({
  receiverId: A.reporter,
  actions: [transactions.createAccount(), transactions.transfer(yocto(0.2)), transactions.addKey(ownerKp.getPublicKey(), transactions.fullAccessKey())],
  ...opts,
}));

// 3. Shared blocklist: register reporter, reporter files evidence.
await step("add_reporter", () => owner.functionCall({ contractId: A.vault, methodName: "add_reporter", args: { reporter: A.reporter }, gas: 30n * TGAS, ...opts }));
const reporter = await accountFor(A.reporter, s.keys.ownerFull);
await step("report_bad_payee", () => reporter.functionCall({
  contractId: A.vault, methodName: "report", gas: 30n * TGAS,
  args: { target: A.badPayee, reason: "Prompt-injected 'unlock your profits' chart asked agents to pay this account", evidence_hash: sha256File(resolve(ROOT, "fixtures/charts/spoofed-profit.png")), evidence_uri: "https://github.com/leoresendedop-sys/nearjev/blob/master/fixtures/charts/spoofed-profit.png" },
  ...opts,
}));

s.deployed = true;
saveState(s);
log("\nVault policy (live):");
log(JSON.stringify(await view(A.vault, "get_policy"), null, 2));
log(`is_blocked(${A.badPayee}) = ${await view(A.vault, "is_blocked", { target: A.badPayee })}`);
void utils;
