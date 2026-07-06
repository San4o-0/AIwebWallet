//! Тест-правило безпеки (ТЗ розділ 6, п.3): бекенд НЕ має ендпоінтів,
//! що приймають приватні ключі чи seed-фрази.
//!
//! Сканує вихідний код crate (src/**/*.rs) і фейлиться, якщо в коді
//! (поза коментарями) з'являється ідентифікатор на кшталт private_key /
//! seed / mnemonic — тобто хтось додав таке DTO-поле.

use std::fs;
use std::path::{Path, PathBuf};

/// Заборонені ідентифікатори полів. Складаються конкатенацією, щоб цей
/// список сам не тригерив подібні сканери.
fn forbidden_identifiers() -> Vec<String> {
    let key = "key";
    let phrase = "phrase";
    vec![
        format!("private_{key}"),
        format!("priv_{key}"),
        format!("secret_{key}"),
        format!("signing_{key}"),
        format!("seed_{phrase}"),
        "seed".to_string(),
        "mnemonic".to_string(),
        "keystore".to_string(),
    ]
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("читання директорії src") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// Чи містить рядок заборонений ідентифікатор як окреме слово
/// (не частину іншого ідентифікатора).
fn contains_identifier(line: &str, ident: &str) -> bool {
    let lower = line.to_lowercase();
    let mut start = 0;
    while let Some(pos) = lower[start..].find(ident) {
        let abs = start + pos;
        let before_ok = abs == 0
            || !lower.as_bytes()[abs - 1].is_ascii_alphanumeric()
                && lower.as_bytes()[abs - 1] != b'_';
        let end = abs + ident.len();
        let after_ok = end >= lower.len()
            || !lower.as_bytes()[end].is_ascii_alphanumeric()
                && lower.as_bytes()[end] != b'_';
        if before_ok && after_ok {
            return true;
        }
        start = end;
    }
    false
}

#[test]
fn no_dto_fields_accept_keys_or_seeds() {
    let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src_dir, &mut files);
    assert!(!files.is_empty(), "не знайдено файлів у src/");

    let forbidden = forbidden_identifiers();
    let mut violations: Vec<String> = Vec::new();

    for file in &files {
        let content = fs::read_to_string(file).expect("читання файлу");
        for (n, line) in content.lines().enumerate() {
            let trimmed = line.trim_start();
            // Коментарі та док-коментарі дозволені (там описане саме правило).
            if trimmed.starts_with("//") {
                continue;
            }
            for ident in &forbidden {
                if contains_identifier(line, ident) {
                    violations.push(format!(
                        "{}:{}: заборонений ідентифікатор `{}` у рядку: {}",
                        file.display(),
                        n + 1,
                        ident,
                        line.trim()
                    ));
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "ПОРУШЕННЯ ПРАВИЛА БЕЗПЕКИ (ТЗ розділ 6, п.3) — бекенд не може \
         приймати ключі/seed:\n{}",
        violations.join("\n")
    );
}

#[test]
fn identifier_matcher_works() {
    assert!(contains_identifier("pub private_key: String,", "private_key"));
    assert!(contains_identifier("pub seed: Vec<u8>,", "seed"));
    // Частина довшого ідентифікатора — не спрацьовує.
    assert!(!contains_identifier("pub seedless_mode: bool,", "seed"));
    assert!(!contains_identifier("let keystorearchive = 1;", "keystore"));
}
