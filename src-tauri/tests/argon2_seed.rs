//! Confirms the Argon2id hash committed in migrations/0003_seed.sql actually
//! verifies against 'admin123' using this crate's own argon2 — not just the
//! Python tool that generated it.

use argon2::{Argon2, PasswordHash, PasswordVerifier};

#[test]
fn seeded_admin_hash_verifies() {
    let hash = "$argon2id$v=19$m=65536,t=3,p=4$OYPlv3sSJAndGlcNx18oXg$LxF/kP3p6qbrmzXdw2Xi7LWB6zwOdl5zdr/rHOCRE1s";
    let parsed = PasswordHash::new(hash).expect("hash should parse");
    Argon2::default()
        .verify_password(b"admin123", &parsed)
        .expect("hash should verify against 'admin123'");
}
