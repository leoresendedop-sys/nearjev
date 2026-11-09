// Minimal HTTP check service (fixture world). POST /check with a PaymentIntent:
//   curl -s localhost:8787/check -d '{"agent":"agent.jev.testnet","receiver":"payout-unlock.testnet","amountYocto":"4900000000000000000000000","kind":"pay","evidenceImage":"fixtures/charts/spoofed-profit.png"}'
// Returns {verdict, reasons, rules, scores, ticket?}. The ticket is what the
// agent passes to the vault's `pay` method.

import { createServer } from "node:http";
import { resolve } from "node:path";
import { buildWorld } from "./world.ts";
import { ROOT } from "./util.ts";

const w = buildWorld();
const port = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/check") { res.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 1e5) { res.writeHead(413).end(); return; } }
  try {
    const intent = JSON.parse(body);
    if (intent.evidenceImage) {
      // Only allow images inside the project (no arbitrary file reads).
      const p = resolve(ROOT, intent.evidenceImage);
      if (!p.startsWith(ROOT + "/")) throw new Error("evidenceImage must be inside the project");
      intent.evidenceImage = p;
    }
    const r = await w.verifier.check(intent);
    res.writeHead(200, { "content-type": "application/json", "x-service": "NearJev" });
    res.end(JSON.stringify({ service: "NearJev", verdict: r.decision.verdict, reasons: r.decision.reasons, rules: r.decision.rules, scores: r.decision.scores, visual: r.visual, ticket: r.ticket ?? null }, null, 2));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
  }
}).listen(port, "127.0.0.1", () => console.log(`NearJev check service (fixture mode) on http://127.0.0.1:${port}/check`));
