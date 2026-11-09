//! Pure, chain-independent policy rules for the NearJev vault.
//! Kept free of near-sdk so they can be unit-tested anywhere and mirrored
//! 1:1 by the TypeScript simulator in `src/chain/vault.ts`.

pub const MS_PER_DAY: u64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Warn,
    Block,
}

impl Verdict {
    pub fn parse(s: &str) -> Option<Verdict> {
        match s {
            "allow" => Some(Verdict::Allow),
            "warn" => Some(Verdict::Warn),
            "block" => Some(Verdict::Block),
            _ => None,
        }
    }
}

/// What the vault needs before it will release funds for a given verdict.
#[derive(Debug, PartialEq, Eq)]
pub enum Requirement {
    /// Verifier said allow: verifier signature is enough.
    VerifierOnly,
    /// Verifier said warn: a human (owner) co-signature is also required.
    VerifierAndHuman,
    /// Verifier said block: nothing can release funds.
    Refuse,
}

pub fn requirement_for(v: &Verdict) -> Requirement {
    match v {
        Verdict::Allow => Requirement::VerifierOnly,
        Verdict::Warn => Requirement::VerifierAndHuman,
        Verdict::Block => Requirement::Refuse,
    }
}

/// Rolling daily spend window keyed by UTC day index.
pub fn day_index(now_ms: u64) -> u64 {
    now_ms / MS_PER_DAY
}

/// Returns Err(reason) if the payment would break a spend limit.
pub fn check_limits(
    amount: u128,
    per_tx_limit: u128,
    daily_limit: u128,
    spent_today: u128,
) -> Result<(), &'static str> {
    if amount == 0 {
        return Err("amount must be > 0");
    }
    if amount > per_tx_limit {
        return Err("amount exceeds per-transaction limit");
    }
    if spent_today.saturating_add(amount) > daily_limit {
        return Err("amount exceeds daily limit");
    }
    Ok(())
}

/// Shared blocklist rule: blocked when the owner confirmed it, or when at
/// least `threshold` distinct registered reporters filed evidence.
pub fn is_blocked(distinct_reporters: u32, threshold: u32, owner_confirmed: bool) -> bool {
    owner_confirmed || (threshold > 0 && distinct_reporters >= threshold)
}

pub fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len() / 2);
    for i in (0..b.len()).step_by(2) {
        let hi = (b[i] as char).to_digit(16)?;
        let lo = (b[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_requirements() {
        assert_eq!(requirement_for(&Verdict::Allow), Requirement::VerifierOnly);
        assert_eq!(requirement_for(&Verdict::Warn), Requirement::VerifierAndHuman);
        assert_eq!(requirement_for(&Verdict::Block), Requirement::Refuse);
        assert_eq!(Verdict::parse("nope"), None);
    }

    #[test]
    fn limits() {
        assert!(check_limits(5, 10, 20, 0).is_ok());
        assert_eq!(check_limits(0, 10, 20, 0), Err("amount must be > 0"));
        assert_eq!(check_limits(11, 10, 20, 0), Err("amount exceeds per-transaction limit"));
        assert_eq!(check_limits(10, 10, 20, 15), Err("amount exceeds daily limit"));
    }

    #[test]
    fn blocklist_threshold() {
        assert!(!is_blocked(1, 2, false));
        assert!(is_blocked(2, 2, false));
        assert!(is_blocked(0, 2, true));
        assert!(!is_blocked(5, 0, false));
    }

    #[test]
    fn hex() {
        assert_eq!(decode_hex("00ff10"), Some(vec![0, 255, 16]));
        assert_eq!(decode_hex("0"), None);
        assert_eq!(decode_hex("zz"), None);
    }
}
