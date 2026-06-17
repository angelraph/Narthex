#![no_std]
extern crate alloc;

use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, Vec};
use blake2::{Blake2s256, Digest};
use ultrahonk_soroban_verifier::UltraHonkVerifier;

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    IssuerPubKey,
    Vk,
    BannedCountries,
    Nullifier(BytesN<32>),
    Eligible(Address),
}

#[contract]
pub struct ComplianceShield;

#[contractimpl]
impl ComplianceShield {
    pub fn initialize(
        env: Env,
        admin: Address,
        issuer_pubkey: Bytes,
        vk: Bytes,
        banned_countries: Vec<u32>,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        if banned_countries.len() != 5 {
            panic!("Banned countries must be exactly 5");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::IssuerPubKey, &issuer_pubkey);
        env.storage().instance().set(&DataKey::Vk, &vk);
        env.storage().instance().set(&DataKey::BannedCountries, &banned_countries);
    }

    pub fn update_vk(env: Env, new_vk: Bytes) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::Vk, &new_vk);
    }

    pub fn update_banned_countries(env: Env, banned_countries: Vec<u32>) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if banned_countries.len() != 5 {
            panic!("Banned countries must be exactly 5");
        }
        env.storage().instance().set(&DataKey::BannedCountries, &banned_countries);
    }

    pub fn register_wallet(
        env: Env,
        proof: Bytes,
        nullifier: BytesN<32>,
        wallet: Address,
    ) {
        wallet.require_auth();

        // 1. Check if nullifier has already been spent
        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nullifier_key) {
            panic!("Nullifier already used");
        }

        // 2. Load parameters
        let vk: Bytes = env.storage().instance().get(&DataKey::Vk).unwrap();
        let banned_countries: Vec<u32> = env.storage().instance().get(&DataKey::BannedCountries).unwrap();

        // 3. Hash the wallet address to match the target_wallet public input
        let xdr_bytes = wallet.to_xdr(&env);
        let mut xdr_vec = alloc::vec![0u8; xdr_bytes.len() as usize];
        xdr_bytes.copy_into_slice(&mut xdr_vec);

        let mut hasher = Blake2s256::new();
        hasher.update(&xdr_vec);
        let mut hash_result = hasher.finalize();
        hash_result[0] &= 0x1f; // Mask top 3 bits to ensure it is within BN254 scalar field modulus
        let mut wallet_hash = [0u8; 32];
        wallet_hash.copy_from_slice(&hash_result);

        // 4. Construct public inputs payload
        let mut public_inputs = Bytes::new(&env);
        public_inputs.append(&nullifier.clone().into());
        public_inputs.append(&Bytes::from_slice(&env, &wallet_hash));
        
        for i in 0..5 {
            let country = banned_countries.get(i).unwrap();
            let mut country_bytes = [0u8; 32];
            let country_be = country.to_be_bytes();
            country_bytes[28] = country_be[0];
            country_bytes[29] = country_be[1];
            country_bytes[30] = country_be[2];
            country_bytes[31] = country_be[3];
            public_inputs.append(&Bytes::from_slice(&env, &country_bytes));
        }

        // 5. Verify proof
        let verifier = match UltraHonkVerifier::new(&env, &vk) {
            Ok(v) => v,
            Err(_) => panic!("Failed to load VK"),
        };

        if verifier.verify(&env, &proof, &public_inputs).is_err() {
            panic!("ZK Proof Verification failed");
        }

        // 6. Save nullifier and mark wallet as eligible
        env.storage().persistent().set(&nullifier_key, &true);
        env.storage().persistent().set(&DataKey::Eligible(wallet), &true);
    }

    pub fn is_wallet_eligible(env: Env, wallet: Address) -> bool {
        env.storage().persistent().get(&DataKey::Eligible(wallet)).unwrap_or(false)
    }
}

#[cfg(test)]
mod test;
