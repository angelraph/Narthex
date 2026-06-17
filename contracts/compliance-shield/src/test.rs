#![cfg(test)]
use super::*;
use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, Vec};

#[test]
fn test_compliance_flow() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let wallet = Address::generate(&env);
    let issuer_pub_key = Bytes::from_slice(&env, &[0u8; 64]);
    
    // Construct a mock VK with correct header metadata of size 1760 bytes:
    // circuit_size = 1024, log_circuit_size = 10, public_inputs_size = 23 (16 pairing + 7 public inputs), pub_inputs_offset = 0
    let mut vk_mock = [0u8; 1760];
    // circuit_size (u64 big-endian at offset 0..8): 1024
    vk_mock[6] = 0x04;
    vk_mock[7] = 0x00;
    // log_circuit_size (u64 big-endian at offset 8..16): 10
    vk_mock[15] = 10;
    // public_inputs_size (u64 big-endian at offset 16..24): 23 (16 pairing points + 7 public inputs)
    vk_mock[23] = 23;
    
    let vk = Bytes::from_slice(&env, &vk_mock);
    let banned_countries = Vec::from_array(&env, [1, 2, 3, 4, 5]);

    // Register contract
    let contract_id = env.register_contract(None, ComplianceShield);
    let client = ComplianceShieldClient::new(&env, &contract_id);

    // Initialize
    client.initialize(&admin, &issuer_pub_key, &vk, &banned_countries);

    // Verify initial eligibility state (false)
    assert!(!client.is_wallet_eligible(&wallet));

    // Admin updates verification key
    let new_vk_mock = vk_mock.clone();
    client.update_vk(&Bytes::from_slice(&env, &new_vk_mock));

    // Admin updates banned countries list
    let new_banned_countries = Vec::from_array(&env, [6, 7, 8, 9, 10]);
    client.update_banned_countries(&new_banned_countries);
}

#[test]
#[should_panic(expected = "Already initialized")]
fn test_already_initialized() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let issuer_pub_key = Bytes::from_slice(&env, &[0u8; 64]);
    
    let mut vk_mock = [0u8; 1760];
    vk_mock[7] = 1024u8.to_be_bytes()[0]; // dummy setup
    let vk = Bytes::from_slice(&env, &vk_mock);
    let banned_countries = Vec::from_array(&env, [1, 2, 3, 4, 5]);

    let contract_id = env.register_contract(None, ComplianceShield);
    let client = ComplianceShieldClient::new(&env, &contract_id);

    client.initialize(&admin, &issuer_pub_key, &vk, &banned_countries);
    client.initialize(&admin, &issuer_pub_key, &vk, &banned_countries);
}
