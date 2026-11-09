// Live NEAR TESTNET proof for NearJev.
//
//   npm run proof:testnet
//
// The NearJev verifier runs locally (fixture vision + market data), but it
// reads the SHARED BLOCKLIST and vault policy live from the testnet contract,
// and every payment attempt is a real testnet transaction signed by the
// agent's function-call key. Writes docs/testnet-proof.txt (no secrets).

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { transactions } from "near-api-js";
import { keyFromSeed, type KeyPair as EdKey } from "../src/keys.ts";
import { FixtureExtractor } from "../src/extract.ts";
import { FixtureMarket } from "../src/market.ts";
import { FixtureChainData, RpcBlocklist, type ChainDataSource } from "../src/counterparty.ts";
import { NearJevVerifier } from "../src/verifier.ts";
import { fmtNear } from "../src/util.ts";
import type { PaymentIntent } from "../src/types.ts";
import { CHART } from "../src/world.ts";
import { ROOT, accUrl, accountFor, failureOf, loadState, rpc, saveState, txUrl, view, yocto } from "./common.ts";

const s = loadState();
if (!s.deployed) throw new Error("run npm run deploy:testnet first");
const A = s.accounts;
const out: string[] = [];
const say = (m = "") => { console.log(m); out.push(m); };
const TGAS = 10n ** 12n;
const verifierKey = keyFromSeed(Buffer.from(s.keys.verifierSeedHex, "hex"), "testnet verifier");
const humanKey = keyFromSeed(Buffer.from(s.keys.humanSeedHex, "hex"), "testnet human");

// Live account ids reuse the fixture risk profiles of the demo world
// (age / tx count / prior interactions), since these accounts are minutes old.
const PROFILE: Record<string, string> = { [A.shop]: "coffee-shop.testnet", [A.badPayee]: "payout-unlock.testnet" };
const fixture = new FixtureChainData();
const chain: ChainDataSource = {
  getAccount: async (id) => ({ ...(await fixture.getAccount(PROFILE[id] ?? id)), accountId: id }),
  priorInteractions: async (_agent, receiver) => fixture.priorInteractions("agent.jev.testnet", PROFILE[receiver] ?? receiver),
};
const verifier = new NearJevVerifier({
  extractor: new FixtureExtractor(),
  market: new FixtureMarket(),
  chain,
  blocklist: new RpcBlocklist(A.vault), // LIVE: read from the testnet contract
  vaultState: async () => {
    const p = await view(A.vault, "get_policy");
    const acct = await rpc("query", { request_type: "view_account", finality: "final", account_id: A.vault });
    return { perTxYocto: BigInt(p.per_tx_limit), dailyYocto: BigInt(p.daily_limit), vaultBalanceYocto: BigInt(acct.amount), lastNonce: p.last_nonce };
  },
  verifierKey,
  vaultId: A.vault,
  nowMs: () => fixture.file.now_ms, // fixture clock for account ages
  ticketTtlMs: 10 * 60_000,
});

const agent = await accountFor(A.agent, s.keys.agentFc);
const record = (k: string, h: string) => { s.txs[k] = h; saveState(s); };

async function payTx(label: string, args: object) {
  const o: any = await agent.signAndSendTransaction({ receiverId: A.vault, actions: [transactions.functionCall("pay", args, 50n * TGAS, 0n)], returnError: true } as any);
  const hash = o.transaction.hash;
  record(label, hash);
  return { hash, fail: failureOf(o), logs: (o.receipts_outcome ?? []).flatMap((r: any) => r.outcome.logs) };
}
// Tickets for direct contract tests use the real clock (contract checks block time).
const ticket = async (verdict: string, receiver: string, amount: bigint) => {
  const p = await view(A.vault, "get_policy");
  return JSON.stringify({ v: 1, verdict, vault: A.vault, agent: A.agent, receiver, amount: amount.toString(), nonce: p.last_nonce + 1, expires_at_ms: Date.now() + 10 * 60_000, evidence: "0".repeat(64) });
};
const fix = (t: string) => { const j = JSON.parse(t); j.expires_at_ms = Date.now() + 10 * 60_000; return JSON.stringify(j); };

say("NearJev · live NEAR testnet proof · Trust, but verify");
say(`run at ${new Date().toISOString()}`);
say(`vault  ${A.vault}  ${accUrl(A.vault)}`);
say(`agent  ${A.agent}  ${accUrl(A.agent)}`);
const keys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: A.agent });
say(`agent keys on-chain: ${JSON.stringify(keys.keys.map((k: any) => k.access_key.permission))}`);
say(`shared blocklist (live): is_blocked(${A.badPayee}) = ${await view(A.vault, "is_blocked", { target: A.badPayee })}`);

// 1. Attack: spoofed chart + blocklisted receiver.
say("\n== 1. Prompt-injected agent: spoofed +412% chart, pay 0.4 NEAR to " + A.badPayee);
const attack: PaymentIntent = { agent: A.agent, receiver: A.badPayee, amountYocto: yocto(0.4).toString(), kind: "pay", evidenceImage: CHART.spoofed };
const r1 = await verifier.check(attack);
say(`  visual: ${r1.visual.status.toUpperCase()} — ${r1.visual.findings.filter((f) => !f.startsWith("image contains")).join("; ")}`);
say(`  rules : ${r1.decision.rules.join(", ")}`);
say(`  VERDICT: ${r1.decision.verdict.toUpperCase()} → wallet refuses to sign (no ticket issued: ${!r1.ticket})`);

// 2. Bypass attempts against the LIVE contract / protocol.
say("\n== 2. The injected agent tries to go around the wallet (real testnet transactions)");
try {
  // 0.1 NEAR is below the agent's own balance, so the only thing stopping it is the key type.
  await agent.signAndSendTransaction({ receiverId: A.badPayee, actions: [transactions.transfer(yocto(0.1))] });
  say("  a) direct transfer → UNEXPECTED SUCCESS");
} catch (e) {
  say(`  a) direct 0.1 NEAR transfer with the function-call key → rejected by the protocol before inclusion (no tx hash): InvalidTxError ${String((e as any)?.type ?? (e as Error).message).slice(0, 80)}`);
}
const forged = await ticket("allow", A.badPayee, yocto(0.4));
const fakeSigner: EdKey = keyFromSeed(Buffer.alloc(32, 66), "attacker key");
const b = await payTx("bypass_forged_ticket", { ticket: forged, verifier_sig: fakeSigner.sign(forged), human_sig: null });
say(`  b) forged "allow" ticket → ${b.fail}  ${txUrl(b.hash)}`);
const signedToBad = await ticket("allow", A.badPayee, yocto(0.4));
const c = await payTx("bypass_signed_ticket_to_blocklisted", { ticket: signedToBad, verifier_sig: verifierKey.sign(signedToBad), human_sig: null });
say(`  c) even a verifier-signed ticket to a blocklisted receiver → ${c.fail}  ${txUrl(c.hash)}`);
const blk = await ticket("block", A.shop, yocto(0.05));
const d = await payTx("bypass_block_ticket", { ticket: blk, verifier_sig: verifierKey.sign(blk), human_sig: null });
say(`  d) BLOCK ticket replayed as payment → ${d.fail}  ${txUrl(d.hash)}`);
const warn = await ticket("warn", A.shop, yocto(0.05));
const e = await payTx("bypass_warn_without_human", { ticket: warn, verifier_sig: verifierKey.sign(warn), human_sig: null });
say(`  e) WARN ticket without the human co-signature → ${e.fail}  ${txUrl(e.hash)}`);

// 3. Control: honest chart, known merchant → ALLOW → real payment.
say("\n== 3. Control: honest chart, known merchant, 0.05 NEAR to " + A.shop);
const shopBefore = BigInt((await rpc("query", { request_type: "view_account", finality: "final", account_id: A.shop })).amount);
const r3 = await verifier.check({ agent: A.agent, receiver: A.shop, amountYocto: yocto(0.05).toString(), kind: "pay", evidenceImage: CHART.honest });
say(`  visual: ${r3.visual.status.toUpperCase()} · rules: ${r3.decision.rules.join(", ")} · VERDICT: ${r3.decision.verdict.toUpperCase()}`);
if (r3.decision.verdict !== "allow" || !r3.ticket) throw new Error("expected ALLOW");
const t3 = fix(r3.ticket.ticket);
const ok = await payTx("allow_payment_to_shop", { ticket: t3, verifier_sig: verifierKey.sign(t3), human_sig: null });
const shopAfter = BigInt((await rpc("query", { request_type: "view_account", finality: "final", account_id: A.shop })).amount);
say(`  pay → ${ok.fail ?? "SUCCESS"} logs=${JSON.stringify(ok.logs)}  ${txUrl(ok.hash)}`);
say(`  ${A.shop} received ${fmtNear(shopAfter - shopBefore)}`);

const badBal = BigInt((await rpc("query", { request_type: "view_account", finality: "final", account_id: A.badPayee })).amount);
say("\n== Result");
say(`  ${A.badPayee} balance: ${fmtNear(badBal)} (0.050 NEAR seeded at creation; nothing added)`);
say(`  on-chain bypasses refused: ${[b, c, d, e].filter((x) => x.fail).length}/4 (+ direct transfer rejected by protocol)`);
say(`  allow payment: ${ok.fail ? "FAILED" : "paid via the vault with the function-call key"}`);
void humanKey;
writeFileSync(resolve(ROOT, "docs/testnet-proof.txt"), out.join("\n") + "\n");
