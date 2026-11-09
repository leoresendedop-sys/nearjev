# NearJev on NEAR testnet

Deployed on 2026-11-09 with `npm run setup:testnet && npm run deploy:testnet`. The live proof was run with `npm run proof:testnet` (full output: [testnet-proof.txt](testnet-proof.txt)). **Testnet only. No private keys are in this repo.** The deploy script writes keys to `.near-testnet/`, which is gitignored.

## Accounts

| Role | Account | Keys |
|---|---|---|
| Owner (created by the official testnet faucet service) | [`nearjev-3c1cfe.testnet`](https://testnet.nearblocks.io/address/nearjev-3c1cfe.testnet) | full access (owner) |
| Policy vault + shared blocklist (contract) | [`vault.nearjev-3c1cfe.testnet`](https://testnet.nearblocks.io/address/vault.nearjev-3c1cfe.testnet) | owner's full-access key, for upgrades |
| Agent | [`agent.nearjev-3c1cfe.testnet`](https://testnet.nearblocks.io/address/agent.nearjev-3c1cfe.testnet) | **one function-call key only**: receiver `vault.nearjev-3c1cfe.testnet`, methods `pay`, `return_to_owner`, 0.25 NEAR gas allowance. It never had a full-access key: it was created in one batch (CreateAccount + Transfer + AddKey(FunctionCall)). |
| Demo merchant | [`shop.nearjev-3c1cfe.testnet`](https://testnet.nearblocks.io/address/shop.nearjev-3c1cfe.testnet) | none |
| Blocklisted payee | [`payout-unlock.nearjev-3c1cfe.testnet`](https://testnet.nearblocks.io/address/payout-unlock.nearjev-3c1cfe.testnet) | none |
| Reporter agent | [`reporter-a.nearjev-3c1cfe.testnet`](https://testnet.nearblocks.io/address/reporter-a.nearjev-3c1cfe.testnet) | owner key |

Vault policy at init: per-tx limit 0.5 NEAR, daily limit 1 NEAR, blocklist threshold 1. The verifier and human co-sign keys are fresh ed25519 keys generated for testnet (only their public keys are on-chain), not the DEMO seeds used in the tests. Contract: `contract/res/nearjev_policy_vault.wasm`.

## Deploy transactions

| Step | Tx |
|---|---|
| Faucet creates owner | [FMCu8A9Y…](https://testnet.nearblocks.io/txns/FMCu8A9YdNu6KMk7116CK7UviJF2ixzAxzZjfB4JGXPo) |
| Create vault + deploy wasm + init | [9VtAgyjp…](https://testnet.nearblocks.io/txns/9VtAgyjpo5ghnE8Xhxfb4MrggmwMPPXZ4EGxoY9dAQ2T) |
| Create agent with function-call key only | [6i1Wv5XY…](https://testnet.nearblocks.io/txns/6i1Wv5XY91TULryPsHo379fEWCXjVuzPvTQq3yjUqMrA) |
| Create merchant | [ft72bsaR…](https://testnet.nearblocks.io/txns/ft72bsaRTJvC38jhGFkLXp8zuHLsbBKog4nC5gGT22K) |
| Create blocklisted payee | [CFoE9mCu…](https://testnet.nearblocks.io/txns/CFoE9mCuqaQPm51vtKiGSpzXHdshLLqDw2kBjnrhCvCk) |
| Create reporter agent | [uogBpboh…](https://testnet.nearblocks.io/txns/uogBpbohuJnCzbcVeTr9s9crYQWRXNEq9Jb4Y6ascCp) |
| Register reporter | [HnuE8YZc…](https://testnet.nearblocks.io/txns/HnuE8YZctGD7SBpGyeSgjgbZ9e5VutnzAskLJvbmkcDr) |
| Reporter files evidence → payee blocklisted | [HR8Qh69X…](https://testnet.nearblocks.io/txns/HR8Qh69Xtzepphc14wqUQgxo17hLaNwRPCPixB8cHtLP) |

## Live proof (all signed by the agent's function-call key)

The verifier runs locally, with fixture vision and market data and the demo risk profiles mapped onto these new accounts. It reads the **shared blocklist and vault policy live** from the testnet contract. For the spoofed chart + blocklisted payee it returns **BLOCK** and issues no ticket. The agent then tries to get around the wallet:

| Attempt | Result | Tx |
|---|---|---|
| a) direct 0.1 NEAR transfer to the payee | rejected by the protocol before inclusion: `InvalidTxError` `RequiresFullAccess` (so no tx hash) | — |
| b) forged "allow" ticket (wrong signer) | ❌ `invalid verifier signature` | [Bx1snyGz…](https://testnet.nearblocks.io/txns/Bx1snyGzyrUyuUyW9JZRrAJrqwoqX94ELPWqL9nRcbWv) |
| c) verifier-signed ticket to the blocklisted payee | ❌ `receiver is on the shared blocklist` | [EUGJuyLQ…](https://testnet.nearblocks.io/txns/EUGJuyLQgKuUXsA3vqZiQ8eMui9eyEkNJpqeWJX38H29) |
| d) BLOCK ticket used as a payment | ❌ `verdict is BLOCK: refusing to pay` | [a2LuYyy3…](https://testnet.nearblocks.io/txns/a2LuYyy3pfBvVAtaadtkGCim8Xus5sZQf4soSsJ5tpN) |
| e) WARN ticket without the human co-signature | ❌ `verdict is WARN: human co-signature required` | [8P8y8jhZ…](https://testnet.nearblocks.io/txns/8P8y8jhZiNsGjZojs5uhRr2ULkUqBeQcm8GWTgJeYqwD) |
| Control: honest chart + known merchant → ALLOW, 0.05 NEAR | ✅ paid through the vault (`JEV_PAY verdict=allow`) | [54UQ6hve…](https://testnet.nearblocks.io/txns/54UQ6hveJtDcU88ArMk9Xu3DBVqYS1fHYQ1sSSA2yaym) |

The blocklisted payee's balance stayed at the 0.05 NEAR seeded when it was created. An earlier proof run (same contract) also left refused attempts and a 0.05 NEAR allow payment on-chain; they appear in the vault's transaction history.

## Rerun

```bash
npm run setup:testnet     # installs near-api-js in testnet/
npm run deploy:testnet    # idempotent; creates a new nearjev-<random>.testnet set if .near-testnet/ is empty
npm run proof:testnet     # writes docs/testnet-proof.txt
```
