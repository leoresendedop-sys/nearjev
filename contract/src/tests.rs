use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const NOW_MS: u64 = 1_800_000_000_000;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn keys() -> (SigningKey, SigningKey) {
    // Deterministic throwaway DEMO keys. Never use for real funds.
    (SigningKey::from_bytes(&[7u8; 32]), SigningKey::from_bytes(&[9u8; 32]))
}

fn ctx(pred: &str) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("vault.jev.testnet"))
        .predecessor_account_id(acc(pred))
        .block_timestamp(NOW_MS * 1_000_000)
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

fn vault() -> Vault {
    let (v, h) = keys();
    ctx("owner.testnet");
    Vault::new(
        acc("owner.testnet"),
        acc("agent.testnet"),
        hex(&v.verifying_key().to_bytes()),
        hex(&h.verifying_key().to_bytes()),
        U128(5 * 10u128.pow(24)),
        U128(8 * 10u128.pow(24)),
        2,
    )
}

fn ticket(verdict: &str, receiver: &str, near: u128, nonce: u64) -> String {
    format!(
        r#"{{"v":1,"verdict":"{}","vault":"vault.jev.testnet","agent":"agent.testnet","receiver":"{}","amount":"{}","nonce":{},"expires_at_ms":{},"evidence":"{}"}}"#,
        verdict,
        receiver,
        near * 10u128.pow(24),
        nonce,
        NOW_MS + 60_000,
        "ab".repeat(32)
    )
}

fn sign(k: &SigningKey, msg: &str) -> String {
    hex(&k.sign(msg.as_bytes()).to_bytes())
}

#[test]
fn allow_ticket_pays() {
    let mut c = vault();
    let (v, _) = keys();
    ctx("agent.testnet");
    let t = ticket("allow", "shop.testnet", 1, 1);
    let _ = c.pay(t.clone(), sign(&v, &t), None);
    assert_eq!(c.get_policy().last_nonce, 1);
    assert_eq!(c.get_policy().spent_today.0, 10u128.pow(24));
}

#[test]
#[should_panic(expected = "verdict is BLOCK")]
fn block_ticket_refused() {
    let mut c = vault();
    let (v, _) = keys();
    ctx("agent.testnet");
    let t = ticket("block", "drainer.testnet", 1, 1);
    let _ = c.pay(t.clone(), sign(&v, &t), None);
}

#[test]
#[should_panic(expected = "human co-signature required")]
fn warn_without_human_refused() {
    let mut c = vault();
    let (v, _) = keys();
    ctx("agent.testnet");
    let t = ticket("warn", "newshop.testnet", 1, 1);
    let _ = c.pay(t.clone(), sign(&v, &t), None);
}

#[test]
fn warn_with_human_pays() {
    let mut c = vault();
    let (v, h) = keys();
    ctx("agent.testnet");
    let t = ticket("warn", "newshop.testnet", 1, 1);
    let _ = c.pay(t.clone(), sign(&v, &t), Some(sign(&h, &t)));
    assert_eq!(c.get_policy().last_nonce, 1);
}

#[test]
#[should_panic(expected = "invalid verifier signature")]
fn forged_ticket_refused() {
    let mut c = vault();
    let (_, h) = keys();
    ctx("agent.testnet");
    let t = ticket("allow", "drainer.testnet", 1, 1);
    let _ = c.pay(t.clone(), sign(&h, &t), None); // signed by the wrong key
}

#[test]
#[should_panic(expected = "only the registered agent")]
fn stranger_cannot_pay() {
    let mut c = vault();
    let (v, _) = keys();
    ctx("mallory.testnet");
    let t = ticket("allow", "shop.testnet", 1, 1);
    let _ = c.pay(t.clone(), sign(&v, &t), None);
}

#[test]
#[should_panic(expected = "nonce already used")]
fn replay_refused() {
    let mut c = vault();
    let (v, _) = keys();
    ctx("agent.testnet");
    let t = ticket("allow", "shop.testnet", 1, 1);
    let _ = c.pay(t.clone(), sign(&v, &t), None);
    let _ = c.pay(t.clone(), sign(&v, &t), None);
}

#[test]
#[should_panic(expected = "per-transaction limit")]
fn per_tx_limit() {
    let mut c = vault();
    let (v, _) = keys();
    ctx("agent.testnet");
    let t = ticket("allow", "shop.testnet", 6, 1);
    let _ = c.pay(t.clone(), sign(&v, &t), None);
}

#[test]
fn shared_blocklist_and_defense_in_depth() {
    let mut c = vault();
    ctx("owner.testnet");
    c.add_reporter(acc("agent-a.testnet"));
    c.add_reporter(acc("agent-b.testnet"));
    let ev = "cd".repeat(32);
    ctx("agent-a.testnet");
    c.report(acc("drainer.testnet"), "phishing payout".into(), ev.clone(), "ipfs://x".into());
    assert!(!c.is_blocked(acc("drainer.testnet")));
    ctx("agent-b.testnet");
    c.report(acc("drainer.testnet"), "drained my vault".into(), ev, "ipfs://y".into());
    assert!(c.is_blocked(acc("drainer.testnet")));
    assert_eq!(c.get_reports(acc("drainer.testnet")).len(), 2);

    // Even a validly signed ALLOW ticket cannot pay a blocklisted receiver.
    let (v, _) = keys();
    ctx("agent.testnet");
    let t = ticket("allow", "drainer.testnet", 1, 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = c.pay(t.clone(), sign(&v, &t), None);
    }));
    assert!(r.is_err());
}

#[test]
#[should_panic(expected = "reporter not registered")]
fn unregistered_reporter_refused() {
    let mut c = vault();
    ctx("rando.testnet");
    c.report(acc("x.testnet"), "x".into(), "ab".repeat(32), "".into());
}

#[test]
fn return_to_owner_needs_no_verdict() {
    let mut c = vault();
    ctx("agent.testnet");
    let _ = c.return_to_owner(U128(1));
}

/// Tickets signed by the TypeScript verifier (scripts/export-ticket.ts) are
/// accepted by the Rust contract: same canonical bytes, same ed25519 keys.
#[test]
fn ts_signed_tickets_accepted() {
    let f: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(include_str!("fixtures/ts_tickets.json")).unwrap();
    let (v, h) = keys();
    assert_eq!(f["verifier_pk"].as_str().unwrap(), hex(&v.verifying_key().to_bytes()));
    assert_eq!(f["human_pk"].as_str().unwrap(), hex(&h.verifying_key().to_bytes()));
    let mut c = vault();
    ctx("agent.testnet");
    let a = &f["allow"];
    let _ = c.pay(a["ticket"].as_str().unwrap().into(), a["verifier_sig"].as_str().unwrap().into(), None);
    let w = &f["warn"];
    let _ = c.pay(
        w["ticket"].as_str().unwrap().into(),
        w["verifier_sig"].as_str().unwrap().into(),
        Some(w["human_sig"].as_str().unwrap().into()),
    );
    assert_eq!(c.get_policy().last_nonce, 2);
}
