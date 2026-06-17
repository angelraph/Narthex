#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String, Symbol};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Registry,
    Balance(Address),
    Name,
    Symbol,
}

#[contract]
pub struct RwaToken;

#[contractimpl]
impl RwaToken {
    pub fn initialize(
        env: Env,
        admin: Address,
        registry: Address,
        name: String,
        symbol: String,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Registry, &registry);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
    }

    fn check_eligibility(env: &Env, registry: &Address, wallet: &Address) {
        // Query ComplianceShield registry dynamically using host invoke function
        let is_eligible: bool = env.invoke_contract(
            registry,
            &Symbol::new(env, "is_wallet_eligible"),
            soroban_sdk::vec![env, wallet.clone()],
        );
        if !is_eligible {
            panic!("Wallet is not eligible under ZK-SEP-57 Compliance Shield");
        }
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let registry: Address = env.storage().instance().get(&DataKey::Registry).unwrap();
        Self::check_eligibility(&env, &registry, &to);

        let balance_key = DataKey::Balance(to.clone());
        let current_balance = env.storage().persistent().get(&balance_key).unwrap_or(0i128);
        env.storage().persistent().set(&balance_key, &(current_balance + amount));
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        let registry: Address = env.storage().instance().get(&DataKey::Registry).unwrap();
        Self::check_eligibility(&env, &registry, &from);
        Self::check_eligibility(&env, &registry, &to);

        let from_key = DataKey::Balance(from.clone());
        let to_key = DataKey::Balance(to.clone());

        let from_balance = env.storage().persistent().get(&from_key).unwrap_or(0i128);
        if from_balance < amount {
            panic!("Insufficient balance");
        }

        let to_balance = env.storage().persistent().get(&to_key).unwrap_or(0i128);

        env.storage().persistent().set(&from_key, &(from_balance - amount));
        env.storage().persistent().set(&to_key, &(to_balance + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&DataKey::Balance(id)).unwrap_or(0i128)
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).unwrap()
    }
}

#[cfg(test)]
mod test;
