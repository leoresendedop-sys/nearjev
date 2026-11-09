import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURES = resolve(ROOT, "fixtures");

export const YOCTO = 10n ** 24n;
export const near = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
export const fmtNear = (y: bigint | string): string => {
  const v = typeof y === "string" ? BigInt(y) : y;
  const whole = v / YOCTO;
  const frac = ((v % YOCTO) * 1000n) / YOCTO;
  return `${whole}.${frac.toString().padStart(3, "0")} NEAR`;
};

export const sha256File = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
export const sha256 = (b: string | Buffer): string => createHash("sha256").update(b).digest("hex");
export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

export const DAY_MS = 86_400_000;
export const isLive = (): boolean => (process.env.JEV_MODE ?? "fixture") === "live";
