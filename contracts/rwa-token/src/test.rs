#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String, Symbol};

// Simple mock registry contract to simulate the ComplianceShield eligibility responses
#[contract]
pub struct MockRegistry;

#[contractimpl]
impl MockRegistry {
    pub fn is_wallet_eligible(env: Env, wallet: Address) -> bool {
        env.storage().instance().get(&wallet).unwrap_or(false)
    }
    
    pub fn set_eligible(env: Env, wallet: Address, eligible: bool) {
        env.storage().instance().set(&wallet, &eligible);
    }
}

#[test]
fn test_rwa_token_transfer_restricted() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    
    // Register mock registry
    let registry_id = env.register_contract(None, MockRegistry);
    let registry_client = MockRegistryClient::new(&env, &registry_id);

    // Register RwaToken
    let token_id = env.register_contract(None, RwaToken);
    let token_client = RwaTokenClient::new(&env, &token_id);

    let name = String::from_slice(&env, "Real Estate Token");
    let symbol = String::from_slice(&env, "RET");

    token_client.initialize(&admin, &registry_id, &name, &symbol);

    let user_a = Address::generate(&env);
    let user_b = Address::generate(&env);

    // Initial balances are 0
    assert_eq!(token_client.balance(&user_a), 0);

    // Try to mint to user_a (should panic because user_a is not eligible)
    let res = token_client.try_mint(&user_a, &1000);
    assert!(res.is_err());

    // Mark user_a as eligible in mock registry
    registry_client.set_eligible(&user_a, &true);

    // Mint now succeeds
    token_client.mint(&user_a, &1000);
    assert_eq!(token_client.balance(&user_a), 1000);

    // Try to transfer from user_a to user_b (should fail because user_b is not eligible)
    let res = token_client.try_transfer(&user_a, &user_b, &400);
    assert!(res.is_err());

    // Mark user_b as eligible
    registry_client.set_eligible(&user_b, &true);

    // Transfer succeeds
    token_client.transfer(&user_a, &user_b, &400);
    assert_eq!(token_client.balance(&user_a), 600);
    assert_eq!(token_client.balance(&user_b), 400);
}
