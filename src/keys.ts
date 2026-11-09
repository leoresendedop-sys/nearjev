// Ed25519 helpers (node:crypto only).
//
// DEMO KEYS: deterministic throwaway seeds so tests and the attack demo are
// reproducible. They protect nothing and must never hold real funds.

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, KeyObject } from "node:crypto";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface KeyPair {
  label: string;
  publicKeyHex: string;
  sign(msg: string | Buffer): string; // hex signature
}

export function keyFromSeed(seed: Buffer, label: string): KeyPair {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const priv: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer;
  return {
    label,
    publicKeyHex: pub.subarray(pub.length - 32).toString("hex"),
    sign: (msg) => edSign(null, Buffer.isBuffer(msg) ? msg : Buffer.from(msg), priv).toString("hex"),
  };
}

export function verifySig(publicKeyHex: string, msg: string | Buffer, sigHex: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/i.test(sigHex) || !/^[0-9a-f]{64}$/i.test(publicKeyHex)) return false;
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return edVerify(null, Buffer.isBuffer(msg) ? msg : Buffer.from(msg), pub, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}

const seed = (b: number) => Buffer.alloc(32, b);

/** DEMO ONLY. Same seeds as contract/src/tests.rs so signatures are interchangeable. */
export const DEMO_KEYS = {
  verifier: () => keyFromSeed(seed(7), "DEMO verifier key (Jev Verify service)"),
  human: () => keyFromSeed(seed(9), "DEMO human-owner co-sign key"),
  agentFc: () => keyFromSeed(seed(11), "DEMO agent function-call key"),
  ownerFull: () => keyFromSeed(seed(13), "DEMO owner full-access key"),
  reporterA: () => keyFromSeed(seed(21), "DEMO agent-a reporter key"),
  reporterB: () => keyFromSeed(seed(22), "DEMO agent-b reporter key"),
};
