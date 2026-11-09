//! Jev Policy Vault — the ONLY contract the agent's function-call key may call.
//!
//! * Holds the agent's spending money (the agent account itself holds only a
//!   function-call key, so it cannot transfer NEAR directly).
//! * `pay` releases funds only with a fresh verdict ticket signed by the Jev
//!   Verify verifier key; `warn` tickets also need the human owner's co-signature;
//!   `block` tickets are always refused.
//! * Enforces per-tx and daily limits, one-time nonces and ticket expiry.
//! * Hosts a shared blocklist that registered agents report to, with evidence.
//! * `return_to_owner` (decreasing risk) never needs a verdict.

pub mod policy;

use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};
use policy::{Requirement, Verdict};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Report {
    pub reporter: AccountId,
    pub reason: String,
    /// sha256 (hex) of the evidence bundle (screenshot, tx hashes, logs).
    pub evidence_hash: String,
    /// Where the evidence lives (IPFS/Arweave/https).
    pub evidence_uri: String,
    pub timestamp_ms: u64,
}

/// Verdict ticket produced by the off-chain verifier. Signed as the exact
/// JSON string passed to `pay` (no re-serialisation ambiguity).
#[near(serializers = [json])]
pub struct Ticket {
    pub v: u8,
    pub verdict: String,
    pub vault: AccountId,
    pub agent: AccountId,
    pub receiver: AccountId,
    pub amount: U128,
    pub nonce: u64,
    pub expires_at_ms: u64,
    /// sha256 of the image the agent attached (binds verdict to evidence).
    pub evidence: String,
}

#[near(serializers = [json])]
pub struct PolicyView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub verifier_pk: String,
    pub human_pk: String,
    pub per_tx_limit: U128,
    pub daily_limit: U128,
    pub spent_today: U128,
    pub last_nonce: u64,
    pub block_threshold: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent: AccountId,
    verifier_pk: [u8; 32],
    human_pk: [u8; 32],
    per_tx_limit: u128,
    daily_limit: u128,
    spent_day: u64,
    spent_today: u128,
    last_nonce: u64,
    block_threshold: u32,
    reporters: LookupSet<AccountId>,
    reports: LookupMap<AccountId, Vec<Report>>,
    confirmed: LookupSet<AccountId>,
}

fn pk32(hex: &str) -> [u8; 32] {
    let v = policy::decode_hex(hex).unwrap_or_else(|| env::panic_str("bad hex key"));
    v.try_into().unwrap_or_else(|_| env::panic_str("key must be 32 bytes"))
}

fn sig64(hex: &str) -> [u8; 64] {
    let v = policy::decode_hex(hex).unwrap_or_else(|| env::panic_str("bad hex signature"));
    v.try_into().unwrap_or_else(|_| env::panic_str("signature must be 64 bytes"))
}

#[near]
impl Vault {
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        verifier_pk_hex: String,
        human_pk_hex: String,
        per_tx_limit: U128,
        daily_limit: U128,
        block_threshold: u32,
    ) -> Self {
        Self {
            owner,
            agent,
            verifier_pk: pk32(&verifier_pk_hex),
            human_pk: pk32(&human_pk_hex),
            per_tx_limit: per_tx_limit.0,
            daily_limit: daily_limit.0,
            spent_day: 0,
            spent_today: 0,
            last_nonce: 0,
            block_threshold,
            reporters: LookupSet::new(b"r"),
            reports: LookupMap::new(b"p"),
            confirmed: LookupSet::new(b"c"),
        }
    }

    // ---------------------------------------------------------------- funds

    /// Owner tops up the vault.
    #[payable]
    pub fn deposit(&mut self) {
        require!(env::predecessor_account_id() == self.owner, "only owner can fund");
    }

    /// Agent-only. Releases `ticket.amount` to `ticket.receiver` if the ticket
    /// is valid. Callable with a function-call key (no attached deposit).
    pub fn pay(&mut self, ticket: String, verifier_sig: String, human_sig: Option<String>) -> Promise {
        let caller = env::predecessor_account_id();
        require!(caller == self.agent, "only the registered agent can pay");

        let t: Ticket = near_sdk::serde_json::from_str(&ticket)
            .unwrap_or_else(|_| env::panic_str("malformed ticket"));
        require!(t.v == 1, "unsupported ticket version");
        require!(t.vault == env::current_account_id(), "ticket is for another vault");
        require!(t.agent == caller, "ticket is for another agent");
        require!(t.nonce > self.last_nonce, "ticket nonce already used");
        require!(t.expires_at_ms >= env::block_timestamp_ms(), "ticket expired");

        require!(
            env::ed25519_verify(&sig64(&verifier_sig), ticket.as_bytes(), &self.verifier_pk),
            "invalid verifier signature"
        );

        let verdict = Verdict::parse(&t.verdict).unwrap_or_else(|| env::panic_str("bad verdict"));
        match policy::requirement_for(&verdict) {
            Requirement::Refuse => env::panic_str("verdict is BLOCK: refusing to pay"),
            Requirement::VerifierAndHuman => {
                let hs = human_sig.unwrap_or_else(|| env::panic_str("verdict is WARN: human co-signature required"));
                require!(
                    env::ed25519_verify(&sig64(&hs), ticket.as_bytes(), &self.human_pk),
                    "invalid human signature"
                );
            }
            Requirement::VerifierOnly => {}
        }

        // Defense in depth: the on-chain blocklist wins even over a signed ticket.
        require!(!self.is_blocked(t.receiver.clone()), "receiver is on the shared blocklist");

        let today = policy::day_index(env::block_timestamp_ms());
        if today != self.spent_day {
            self.spent_day = today;
            self.spent_today = 0;
        }
        if let Err(e) = policy::check_limits(t.amount.0, self.per_tx_limit, self.daily_limit, self.spent_today) {
            env::panic_str(e);
        }

        self.spent_today += t.amount.0;
        self.last_nonce = t.nonce;
        env::log_str(&format!(
            "JEV_PAY verdict={} receiver={} amount={} nonce={}",
            t.verdict, t.receiver, t.amount.0, t.nonce
        ));
        Promise::new(t.receiver).transfer(NearToken::from_yoctonear(t.amount.0))
    }

    /// Agent-only. Decreasing risk is always allowed: send funds back to the
    /// owner without any verdict.
    pub fn return_to_owner(&mut self, amount: U128) -> Promise {
        let caller = env::predecessor_account_id();
        require!(caller == self.agent || caller == self.owner, "only agent or owner");
        env::log_str(&format!("JEV_RETURN amount={}", amount.0));
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    // ------------------------------------------------------------ blocklist

    pub fn add_reporter(&mut self, reporter: AccountId) {
        self.assert_owner();
        self.reporters.insert(reporter);
    }

    /// Registered agents (and the owner) report bad receivers with evidence.
    pub fn report(&mut self, target: AccountId, reason: String, evidence_hash: String, evidence_uri: String) {
        let reporter = env::predecessor_account_id();
        require!(
            reporter == self.owner || self.reporters.contains(&reporter),
            "reporter not registered"
        );
        require!(evidence_hash.len() == 64, "evidence_hash must be sha256 hex");
        require!(reason.len() <= 280 && evidence_uri.len() <= 512, "report too long");
        let mut list = self.reports.get(&target).cloned().unwrap_or_default();
        list.retain(|r| r.reporter != reporter); // one live report per reporter
        list.push(Report {
            reporter,
            reason,
            evidence_hash,
            evidence_uri,
            timestamp_ms: env::block_timestamp_ms(),
        });
        self.reports.insert(target, list);
    }

    pub fn confirm_block(&mut self, target: AccountId) {
        self.assert_owner();
        self.confirmed.insert(target);
    }

    pub fn clear_block(&mut self, target: AccountId) {
        self.assert_owner();
        self.confirmed.remove(&target);
        self.reports.remove(&target);
    }

    pub fn is_blocked(&self, target: AccountId) -> bool {
        let n = self.reports.get(&target).map(|l| l.len() as u32).unwrap_or(0);
        policy::is_blocked(n, self.block_threshold, self.confirmed.contains(&target))
    }

    pub fn get_reports(&self, target: AccountId) -> Vec<Report> {
        self.reports.get(&target).cloned().unwrap_or_default()
    }

    pub fn get_policy(&self) -> PolicyView {
        let today = policy::day_index(env::block_timestamp_ms());
        PolicyView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            verifier_pk: hex(&self.verifier_pk),
            human_pk: hex(&self.human_pk),
            per_tx_limit: U128(self.per_tx_limit),
            daily_limit: U128(self.daily_limit),
            spent_today: U128(if today == self.spent_day { self.spent_today } else { 0 }),
            last_nonce: self.last_nonce,
            block_threshold: self.block_threshold,
        }
    }

    pub fn set_limits(&mut self, per_tx_limit: U128, daily_limit: U128) {
        self.assert_owner();
        self.per_tx_limit = per_tx_limit.0;
        self.daily_limit = daily_limit.0;
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only owner");
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

#[cfg(test)]
mod tests;
