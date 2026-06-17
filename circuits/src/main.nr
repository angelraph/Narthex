use std;

fn main(
    // Private Inputs
    user_pubkey_x: [u8; 32],
    user_pubkey_y: [u8; 32],
    user_signature: [u8; 64],
    issuer_signature: [u8; 64],
    issuer_pub_key_x: [u8; 32],
    issuer_pub_key_y: [u8; 32],
    country_code: u32,
    is_accredited: bool,
    secret_salt: Field,

    // Public Inputs
    target_wallet_hash: pub Field,
    banned_countries: pub [u32; 5]
) -> pub Field {
    // 1. Verify user controls user_pubkey by verifying they signed target_wallet_hash
    let hashed_wallet: [u8; 32] = target_wallet_hash.to_be_bytes();
    let user_sig_ok = std::ecdsa_secp256k1::verify_signature(
        user_pubkey_x, user_pubkey_y, user_signature, hashed_wallet
    );
    assert(user_sig_ok == true);

    // 2. Hash credential data: user_pubkey_x, user_pubkey_y, country_code, is_accredited, secret_salt
    // Construct serialized credential bytes (101 bytes)
    let mut cred_bytes = [0; 101];
    for i in 0..32 {
        cred_bytes[i] = user_pubkey_x[i];
        cred_bytes[32 + i] = user_pubkey_y[i];
    }
    cred_bytes[64] = (country_code >> 24) as u8;
    cred_bytes[65] = (country_code >> 16) as u8;
    cred_bytes[66] = (country_code >> 8) as u8;
    cred_bytes[67] = country_code as u8;
    cred_bytes[68] = is_accredited as u8;
    
    let salt_bytes: [u8; 32] = secret_salt.to_be_bytes();
    for i in 0..32 {
        cred_bytes[69 + i] = salt_bytes[i];
    }

    let cred_hash = std::hash::blake2s(cred_bytes);

    // Verify issuer signature over the credential hash
    let issuer_sig_ok = std::ecdsa_secp256k1::verify_signature(
        issuer_pub_key_x, issuer_pub_key_y, issuer_signature, cred_hash
    );
    assert(issuer_sig_ok == true);

    // 3. Ensure country is not banned
    for i in 0..5 {
        assert(country_code != banned_countries[i]);
    }

    // 4. Output a nullifier to prevent double registration
    let mut nullifier_input = [0; 96];
    for i in 0..32 {
        nullifier_input[i] = user_pubkey_x[i];
        nullifier_input[32 + i] = user_pubkey_y[i];
        nullifier_input[64 + i] = salt_bytes[i];
    }

    let nullifier_hash = std::hash::blake2s(nullifier_input);
    let nullifier = Field::from_be_bytes(nullifier_hash);
    
    nullifier
}
