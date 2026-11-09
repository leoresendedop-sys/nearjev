import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT } from "../src/util.ts";

const tsx = resolve(ROOT, "node_modules/.bin/tsx");
const run = (args: string[]) => execFileSync(tsx, args, { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8" });
const warnArgs = ["scripts/check.ts", "--receiver", "fresh-dex.testnet", "--amount", "1", "--image", "fixtures/charts/honest-near-24h.png"];

test("CLI: WARN without --approve-warn does not sign", () => {
  const out = run(warnArgs);
  assert.match(out, /VERDICT : WARN/);
  assert.match(out, /a human would be asked/);
  assert.match(out, /wallet status: refused_needs_human/);
  assert.doesNotMatch(out, /signing FunctionCall/);
});

test("CLI: WARN with --approve-warn signs with the function-call key", () => {
  const out = run([...warnArgs, "--approve-warn"]);
  assert.match(out, /signing FunctionCall\(pay\)/);
  assert.match(out, /wallet status: signed/);
});

test("attack demo exits 0 and reports the attacker received nothing", () => {
  const out = run(["scripts/attack-demo.ts"]);
  assert.match(out, /VERDICT : BLOCK/);
  assert.match(out, /payout-unlock\.testnet: 0\.000 NEAR/);
  assert.match(out, /bypass attempts rejected: 4\/4/);
  assert.match(out, /STOPPED/);
});
