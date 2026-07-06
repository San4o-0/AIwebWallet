//! BIP-39 mnemonic generation, validation and seed recovery.

use bip39::{Language, Mnemonic};
use zeroize::Zeroizing;

use crate::error::WalletError;

/// Supported mnemonic lengths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WordCount {
    /// 12 words (128 bits of entropy).
    Words12,
    /// 24 words (256 bits of entropy).
    Words24,
}

impl WordCount {
    /// Number of words.
    pub fn count(self) -> usize {
        match self {
            WordCount::Words12 => 12,
            WordCount::Words24 => 24,
        }
    }
}

impl TryFrom<usize> for WordCount {
    type Error = WalletError;

    fn try_from(n: usize) -> Result<Self, Self::Error> {
        match n {
            12 => Ok(WordCount::Words12),
            24 => Ok(WordCount::Words24),
            other => Err(WalletError::WordCount(other)),
        }
    }
}

/// Generate a new random English BIP-39 mnemonic (12 or 24 words).
///
/// Entropy comes from the OS CSPRNG (`crypto.getRandomValues` under WASM).
pub fn generate_mnemonic(word_count: WordCount) -> Result<Zeroizing<String>, WalletError> {
    let mnemonic = Mnemonic::generate_in(Language::English, word_count.count())
        .map_err(|e| WalletError::Mnemonic(e.to_string()))?;
    Ok(Zeroizing::new(mnemonic.to_string()))
}

/// Validate a BIP-39 mnemonic phrase (word list + checksum).
pub fn validate_mnemonic(phrase: &str) -> Result<(), WalletError> {
    parse_mnemonic(phrase).map(|_| ())
}

/// Recover the 64-byte BIP-39 seed from a mnemonic and an optional passphrase.
///
/// Pass an empty string for `passphrase` when none is used.
pub fn mnemonic_to_seed(phrase: &str, passphrase: &str) -> Result<Zeroizing<[u8; 64]>, WalletError> {
    let mnemonic = parse_mnemonic(phrase)?;
    Ok(Zeroizing::new(mnemonic.to_seed(passphrase)))
}

fn parse_mnemonic(phrase: &str) -> Result<Mnemonic, WalletError> {
    let normalized = phrase.split_whitespace().collect::<Vec<_>>().join(" ");
    let word_count = normalized.split(' ').count();
    WordCount::try_from(word_count)?;
    Mnemonic::parse_in_normalized(Language::English, &normalized)
        .map_err(|e| WalletError::Mnemonic(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTOR_PHRASE: &str =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    #[test]
    fn generates_valid_mnemonics() {
        for wc in [WordCount::Words12, WordCount::Words24] {
            let phrase = generate_mnemonic(wc).unwrap();
            assert_eq!(phrase.split(' ').count(), wc.count());
            validate_mnemonic(&phrase).unwrap();
        }
    }

    #[test]
    fn generated_mnemonics_are_random() {
        let a = generate_mnemonic(WordCount::Words12).unwrap();
        let b = generate_mnemonic(WordCount::Words12).unwrap();
        assert_ne!(*a, *b);
    }

    /// Standard BIP-39 test vector (Trezor vectors, entropy = 0x00..00, passphrase "TREZOR").
    #[test]
    fn bip39_standard_vector_trezor() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "TREZOR").unwrap();
        assert_eq!(
            hex::encode(*seed),
            "c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04"
        );
    }

    /// Same mnemonic with an empty passphrase (widely used reference value).
    #[test]
    fn bip39_vector_empty_passphrase() {
        let seed = mnemonic_to_seed(VECTOR_PHRASE, "").unwrap();
        assert_eq!(
            hex::encode(*seed),
            "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4"
        );
    }

    #[test]
    fn rejects_bad_checksum() {
        let bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
        assert!(matches!(validate_mnemonic(bad), Err(WalletError::Mnemonic(_))));
    }

    #[test]
    fn rejects_unknown_words_and_lengths() {
        assert!(validate_mnemonic("hello world this is not a mnemonic at all ok ok ok").is_err());
        assert!(matches!(
            validate_mnemonic("abandon abandon abandon"),
            Err(WalletError::WordCount(3))
        ));
    }

    #[test]
    fn tolerates_extra_whitespace() {
        let messy = format!("  {}  ", VECTOR_PHRASE.replace(' ', "   "));
        validate_mnemonic(&messy).unwrap();
    }
}
