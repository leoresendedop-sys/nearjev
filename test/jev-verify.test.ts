import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorld, CHART, IDS } from "../src/world.ts";
import { near } from "../src/util.ts";
import { TGAS, GAS_PRICE_YOCTO } from "../src/chain/sim.ts";
import { FixtureExtractor } from "../src/extract.ts";
import { FixtureMarket, verifyClaims } from "../src/market.ts";
import { GuardedAgentWallet } from "../src/wrapper.ts";
import { DEMO_KEYS } from "../src/keys.ts";

const pay = (receiver: string, amountNear: number, image?: string, kind: "pay" | "return_to_owner" = "pay") => ({
  agent: IDS.agent, receiver, amountYocto: near(amountNear).toString(), kind, evidenceImage: image,
});

test("(a) spoofed profit chart + blocklisted address => BLOCK, nothing signed, no funds move", async () => {
  const w = buildWorld();
  const before = w.chain.balance("payout-unlock.testnet");
  const r = await w.wallet.pay(pay("payout-unlock.testnet", 4.9, CHART.spoofed));
  assert.equal(r.check.decision.verdict, "block");
  assert.equal(r.status, "refused_block");
  assert.equal(w.wallet.signatures.length, 0, "no signature may be produced on BLOCK");
  assert.equal(r.check.ticket, undefined, "verifier issues no ticket on BLOCK");
  assert.equal(w.chain.balance("payout-unlock.testnet"), before);
  assert.ok(r.check.decision.rules.includes("R1_blocklist"));
  assert.ok(r.check.decision.rules.includes("R3b_visual_mismatch_plus_risky_payment"));
  assert.equal(r.check.visual.status, "mismatch");
  assert.ok(r.check.visual.injectionDetected);
});

test("(b) honest chart + known counterparty => ALLOW and a function-call signature is recorded", async () => {
  const w = buildWorld();
  const before = w.chain.balance("coffee-shop.testnet");
  const r = await w.wallet.pay(pay("coffee-shop.testnet", 1, CHART.honest));
  assert.equal(r.check.visual.status, "match");
  assert.equal(r.check.decision.verdict, "allow", r.check.decision.reasons.join("\n"));
  assert.equal(r.status, "signed");
  assert.equal(w.wallet.signatures.length, 1);
  const tx = w.wallet.signatures[0].tx;
  assert.equal(tx.receiverId, IDS.vault);
  assert.deepEqual(tx.actions.map((a) => a.type), ["FunctionCall"]);
  assert.equal(r.outcome!.keyKind, "FunctionCall");
  assert.equal(w.chain.balance("coffee-shop.testnet") - before, near(1));
});

test("(c) WARN path does not sign without human approval (--approve-warn)", async () => {
  const w = buildWorld(); // default: no human approver
  const r = await w.wallet.pay(pay("fresh-dex.testnet", 1, CHART.honest));
  assert.equal(r.check.decision.verdict, "warn", r.check.decision.reasons.join("\n"));
  assert.equal(r.status, "refused_needs_human");
  assert.equal(w.wallet.signatures.length, 0);
  assert.ok(r.check.decision.rules.includes("R5_code_changed_recently"));
});

test("(c2) WARN path signs only after a human approves, and the vault checks the human co-signature", async () => {
  let asked = 0;
  const w = buildWorld({ askHuman: async () => { asked++; return true; } });
  const r = await w.wallet.pay(pay("fresh-dex.testnet", 1, CHART.honest));
  assert.equal(asked, 1);
  assert.equal(r.status, "signed");
  assert.match(r.outcome!.logs[0], /JEV_PAY verdict=warn/);
});

test("vault refuses a WARN ticket without the human co-signature even if the agent skips the wrapper", async () => {
  const w = buildWorld();
  const r = await w.verifier.check(pay("fresh-dex.testnet", 1, CHART.honest));
  assert.equal(r.decision.verdict, "warn");
  const out = w.chain.send(w.chain.signTx(IDS.agent, w.keys.agentFc, IDS.vault, [{
    type: "FunctionCall", methodName: "pay", gas: 50n * TGAS, deposit: 0n,
    args: { ticket: r.ticket!.ticket, verifier_sig: r.ticket!.verifierSig, human_sig: null },
  }]));
  assert.equal(out.status, "Failure");
  assert.match(out.error!, /human co-signature required/);
});

test("function-call key cannot Transfer, call another contract, attach NEAR, or add keys", async () => {
  const w = buildWorld();
  const k = w.keys.agentFc;
  const t1 = w.chain.send(w.chain.signTx(IDS.agent, k, "payout-unlock.testnet", [{ type: "Transfer", deposit: near(0.5) }]));
  assert.match(t1.error!, /RequiresFullAccess/);
  const t2 = w.chain.send(w.chain.signTx(IDS.agent, k, "fresh-dex.testnet", [{ type: "FunctionCall", methodName: "swap", args: {}, gas: TGAS, deposit: 0n }]));
  assert.match(t2.error!, /ReceiverMismatch/);
  const t3 = w.chain.send(w.chain.signTx(IDS.agent, k, IDS.vault, [{ type: "FunctionCall", methodName: "pay", args: {}, gas: TGAS, deposit: 1n }]));
  assert.match(t3.error!, /DepositWithFunctionCall/);
  const t4 = w.chain.send(w.chain.signTx(IDS.agent, k, IDS.agent, [{ type: "AddKey", publicKeyHex: "00".repeat(32), permission: { kind: "FullAccess" } }]));
  assert.match(t4.error!, /RequiresFullAccess/);
  const t5 = w.chain.send(w.chain.signTx(IDS.agent, k, IDS.vault, [{ type: "FunctionCall", methodName: "add_reporter", args: {}, gas: TGAS, deposit: 0n }]));
  assert.match(t5.error!, /MethodNameMismatch/);
});

test("allowance exhaustion locks the function-call key (documented caveat)", async () => {
  const w = buildWorld({ fcAllowance: 60n * TGAS * GAS_PRICE_YOCTO });
  const first = await w.wallet.pay(pay("coffee-shop.testnet", 0.1, CHART.honest));
  assert.equal(first.status, "signed");
  const second = await w.wallet.pay(pay("coffee-shop.testnet", 0.1, CHART.honest));
  assert.equal(second.status, "chain_rejected");
  assert.match(second.outcome!.error!, /NotEnoughAllowance/);
});

test("forged / replayed tickets and blocklisted receivers are refused by the vault itself", async () => {
  const w = buildWorld();
  // Forged: agent signs its own ALLOW ticket.
  const forged = JSON.stringify({ v: 1, verdict: "allow", vault: IDS.vault, agent: IDS.agent, receiver: "payout-unlock.testnet", amount: near(1).toString(), nonce: 1, expires_at_ms: w.chain.nowMs + 60000, evidence: "0".repeat(64) });
  const f = w.chain.send(w.chain.signTx(IDS.agent, w.keys.agentFc, IDS.vault, [{ type: "FunctionCall", methodName: "pay", gas: 50n * TGAS, deposit: 0n, args: { ticket: forged, verifier_sig: w.keys.agentFc.sign(forged) } }]));
  assert.match(f.error!, /invalid verifier signature/);
  // Even a genuinely signed ALLOW ticket cannot pay a blocklisted receiver.
  const sig = w.keys.verifier.sign(forged);
  const b = w.chain.send(w.chain.signTx(IDS.agent, w.keys.agentFc, IDS.vault, [{ type: "FunctionCall", methodName: "pay", gas: 50n * TGAS, deposit: 0n, args: { ticket: forged, verifier_sig: sig } }]));
  assert.match(b.error!, /shared blocklist/);
  // Replay of a used ticket.
  const ok = await w.wallet.pay(pay("coffee-shop.testnet", 0.2, CHART.honest));
  assert.equal(ok.status, "signed");
  const replay = w.chain.send(w.chain.signTx(IDS.agent, w.keys.agentFc, IDS.vault, [{ type: "FunctionCall", methodName: "pay", gas: 50n * TGAS, deposit: 0n, args: ok.signed!.tx.actions[0].type === "FunctionCall" ? ok.signed!.tx.actions[0].args : {} }]));
  assert.match(replay.error!, /nonce already used/);
});

test("an edited image no longer matches its recorded extraction => unverifiable => WARN (fails closed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-"));
  const p = join(dir, "edited.png");
  copyFileSync(CHART.honest, p);
  appendFileSync(p, Buffer.from("tamper"));
  const w = buildWorld();
  const r = await w.wallet.pay(pay("coffee-shop.testnet", 1, p));
  assert.equal(r.check.visual.status, "unverifiable");
  assert.equal(r.check.decision.verdict, "warn");
  assert.equal(r.status, "refused_needs_human");
});

test("decreasing risk is always allowed: return_to_owner passes even with a spoofed chart attached", async () => {
  const w = buildWorld();
  const r = await w.wallet.pay(pay(IDS.owner, 1, CHART.spoofed, "return_to_owner"));
  assert.equal(r.check.decision.verdict, "allow");
  assert.equal(r.status, "signed");
});

test("first payment to an established non-contract receiver => WARN (human approves new receivers once)", async () => {
  const w = buildWorld();
  const r = await w.verifier.check(pay("new-merchant.testnet", 1, CHART.honest));
  assert.equal(r.decision.verdict, "warn");
});

test("spoofed chart alone (known counterparty, small amount) => WARN, not silent allow", async () => {
  const w = buildWorld();
  const r = await w.verifier.check(pay("coffee-shop.testnet", 0.5, CHART.spoofed));
  assert.equal(r.decision.verdict, "warn");
  assert.ok(r.decision.rules.includes("R3_visual_mismatch"));
});

test("the wallet refuses to run with a full-access key", () => {
  const w = buildWorld();
  w.chain.createAccount("careless-agent.testnet", near(1));
  const fk = DEMO_KEYS.ownerFull();
  w.chain.addKeyGenesis("careless-agent.testnet", fk.publicKeyHex, { kind: "FullAccess" });
  assert.throws(() => new GuardedAgentWallet({ chain: w.chain, agentId: "careless-agent.testnet", fcKey: fk, vaultId: IDS.vault, verifier: w.verifier }), /FULL ACCESS/);
});

test("visual verifier: spoofed claims mismatch, honest claims match", async () => {
  const ex = new FixtureExtractor();
  const m = new FixtureMarket();
  const s = await verifyClaims(await ex.extract(CHART.spoofed), m);
  assert.equal(s.status, "mismatch");
  assert.ok(s.findings.some((f) => f.includes("impossible")));
  const h = await verifyClaims(await ex.extract(CHART.honest), m);
  assert.equal(h.status, "match", h.findings.join("; "));
  const none = await verifyClaims(await ex.extract(undefined), m);
  assert.equal(none.status, "none");
});
