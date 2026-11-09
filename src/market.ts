// Market truth + visual claim verification.

import { resolve } from "node:path";
import type { ChartClaims, Extraction, VisualCheck } from "./types.ts";
import { FIXTURES, isLive, readJson } from "./util.ts";

export interface Candle { t: number; o: number; h: number; l: number; c: number }

export interface MarketSource {
  /** Hourly candles covering at least the last `hours` up to `asOf` (ms). */
  candles(symbol: string, hours: number, asOf?: number): Promise<Candle[] | null>;
  now(): number;
}

/** Deterministic fixture (fixtures/market/*.json). */
export class FixtureMarket implements MarketSource {
  private data = readJson<{ symbol: string; as_of: number; candles: Candle[] }>(
    resolve(FIXTURES, "market", "near-usdt-1h.json"),
  );
  now() { return this.data.as_of; }
  async candles(symbol: string, hours: number, asOf = this.data.as_of) {
    if (normSymbol(symbol) !== normSymbol(this.data.symbol)) return null;
    const upTo = this.data.candles.filter((c) => c.t < asOf);
    return upTo.slice(-hours);
  }
}

/** Live adapter: public Binance klines (no key). Not used by tests. */
export class BinanceMarket implements MarketSource {
  now() { return Date.now(); }
  async candles(symbol: string, hours: number) {
    const pair = normSymbol(symbol).replace("/", "");
    try {
      const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&limit=${Math.min(hours, 1000)}`);
      if (!r.ok) return null;
      const rows = (await r.json()) as any[];
      return rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
    } catch { return null; }
  }
}

export const normSymbol = (s: string) => s.toUpperCase().replace(/\s+/g, "").replace("-", "/").replace(/USD$/, "USDT");

const TIMEFRAME_HOURS: Record<string, number> = { "1h": 1, "4h": 4, "24h": 24, "1d": 24, "7d": 168, "1w": 168 };

/** Tolerances (documented in README). */
export const TOLERANCE = { pricePct: 5, changePp: 5, profitPp: 5 };

export async function verifyClaims(ex: Extraction, market: MarketSource): Promise<VisualCheck> {
  if (ex.source === "none") return { status: "none", findings: ["no chart attached"], injectionDetected: false };
  const c: ChartClaims | null = ex.claims;
  if (!c) return { status: "unverifiable", findings: [`could not extract claims (${ex.note ?? "unknown"})`], injectionDetected: false };

  const findings: string[] = [];
  const injectionDetected = c.embedded_instructions.length > 0;
  if (injectionDetected) findings.push(`image contains instructions aimed at the agent: "${c.embedded_instructions[0]}"`);

  const hours = TIMEFRAME_HOURS[(c.timeframe ?? "24h").toLowerCase()] ?? 24;
  const asOf = c.as_of ? Date.parse(c.as_of) : market.now();
  const candles = c.asset ? await market.candles(c.asset, hours, asOf) : null;
  if (!candles || candles.length === 0) {
    findings.push(`no market data for asset ${c.asset ?? "(unreadable)"}`);
    return { status: "unverifiable", findings, injectionDetected };
  }
  const price = candles[candles.length - 1].c;
  const pctChange = (price / candles[0].o - 1) * 100;
  const truth = { price, pctChange, timeframe: `${hours}h`, asOf };
  let mismatch = false;

  if (c.quoted_price != null) {
    const dev = Math.abs(c.quoted_price / price - 1) * 100;
    if (dev > TOLERANCE.pricePct) {
      mismatch = true;
      findings.push(`price claim $${c.quoted_price} vs market $${price.toFixed(3)} (${dev.toFixed(0)}% off, tolerance ${TOLERANCE.pricePct}%)`);
    } else findings.push(`price claim $${c.quoted_price} matches market $${price.toFixed(3)}`);
  }
  if (c.pct_change != null) {
    const d = Math.abs(c.pct_change - pctChange);
    if (d > TOLERANCE.changePp) {
      mismatch = true;
      findings.push(`${truth.timeframe} change claim ${fmtPct(c.pct_change)} vs market ${fmtPct(pctChange)} (tolerance ${TOLERANCE.changePp}pp)`);
    } else findings.push(`${truth.timeframe} change claim ${fmtPct(c.pct_change)} matches market ${fmtPct(pctChange)}`);
  }
  if (c.profit_claim_pct != null) {
    // A holder cannot have made more than the asset moved in that window (spot, unlevered).
    const best = Math.max(pctChange, 0);
    if (c.profit_claim_pct - best > TOLERANCE.profitPp) {
      mismatch = true;
      findings.push(`"already made ${fmtPct(c.profit_claim_pct)}" is impossible: asset moved ${fmtPct(pctChange)} in ${truth.timeframe}`);
    }
  }
  if (c.quoted_price == null && c.pct_change == null && c.profit_claim_pct == null) {
    findings.push("chart has no checkable numeric claims");
    return { status: "unverifiable", findings, truth, injectionDetected };
  }
  // Instructions inside an image are never legitimate payment authority.
  if (injectionDetected) mismatch = true;
  return { status: mismatch ? "mismatch" : "match", findings, truth, injectionDetected };
}

const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;

export const defaultMarket = (): MarketSource => (isLive() ? new BinanceMarket() : new FixtureMarket());
