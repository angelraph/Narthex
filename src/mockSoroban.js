import blake from 'blakejs';
import { Address } from 'stellar-sdk';

export class MockSorobanVM {
  constructor() {
    this.reset();
  }

  reset() {
    // Contract states
    this.shield = {
      initialized: false,
      admin: null,
      issuerPubKey: null,
      vk: null,
      bannedCountries: [],
      nullifiers: new Set(),
      eligible: new Map(), // Wallet Address (string) -> Boolean
    };

    this.token = {
      initialized: false,
      admin: null,
      registry: null,
      name: '',
      symbol: '',
      balances: new Map(), // Wallet Address (string) -> Number
      totalSupply: 0
    };

    // Transaction ledger/logs for the UI
    this.logs = [];
    this.addLog('System', 'Soroban VM simulator initialized');
  }

  addLog(contract, action, status = 'success', details = '') {
    const logEntry = {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date().toLocaleTimeString(),
      contract,
      action,
      status,
      details
    };
    this.logs.unshift(logEntry);
    // Keep last 50 logs
    if (this.logs.length > 50) {
      this.logs.pop();
    }
  }

  // --- HASHING HELPER (Blake2s + Stellar Address XDR) ---
  computeWalletHash(walletAddress) {
    try {
      const trimmed = walletAddress.trim();
      const addr = new Address(trimmed);
      const scAddress = addr.toScAddress();
      const xdrBytes = scAddress.toXDR();
      
      const hashBytes = blake.blake2s(xdrBytes, null, 32);
      hashBytes[0] &= 0x1f; // Mask top 3 bits to fit field modulus
      
      return '0x' + Buffer.from(hashBytes).toString('hex');
    } catch (err) {
      // Fallback for mock/custom testing addresses
      const hashBytes = blake.blake2s(Buffer.from(walletAddress.trim()), null, 32);
      hashBytes[0] &= 0x1f;
      return '0x' + Buffer.from(hashBytes).toString('hex');
    }
  }

  // --- COMPLIANCE SHIELD CONTRACT METHODS ---
  initializeComplianceShield(admin, issuerPubKey, vk, bannedCountries) {
    if (this.shield.initialized) {
      this.addLog('ComplianceShield', 'initialize()', 'failed', 'Already initialized');
      throw new Error('Already initialized');
    }
    if (bannedCountries.length !== 5) {
      this.addLog('ComplianceShield', 'initialize()', 'failed', 'Banned countries must be exactly 5');
      throw new Error('Banned countries must be exactly 5');
    }

    this.shield.admin = admin.trim();
    this.shield.issuerPubKey = issuerPubKey;
    this.shield.vk = vk;
    this.shield.bannedCountries = [...bannedCountries];
    this.shield.initialized = true;

    this.addLog(
      'ComplianceShield',
      'initialize()',
      'success',
      `Admin: ${admin.substring(0, 8)}... | Banned: [${bannedCountries.join(', ')}]`
    );
  }

  updateVk(caller, newVk) {
    this.verifyAuth(caller, this.shield.admin);
    this.shield.vk = newVk;
    this.addLog('ComplianceShield', 'update_vk()', 'success', 'Verification Key updated by Admin');
  }

  updateBannedCountries(caller, bannedCountries) {
    this.verifyAuth(caller, this.shield.admin);
    if (bannedCountries.length !== 5) {
      this.addLog('ComplianceShield', 'update_banned_countries()', 'failed', 'Banned countries must be exactly 5');
      throw new Error('Banned countries must be exactly 5');
    }
    this.shield.bannedCountries = [...bannedCountries];
    this.addLog(
      'ComplianceShield',
      'update_banned_countries()',
      'success',
      `Banned list updated: [${bannedCountries.join(', ')}]`
    );
  }

  registerWallet(walletCaller, proof, nullifier, walletAddress) {
    this.verifyAuth(walletCaller, walletAddress);

    // 1. Check if nullifier has already been spent
    if (this.shield.nullifiers.has(nullifier)) {
      this.addLog('ComplianceShield', 'register_wallet()', 'failed', `Nullifier already used: ${nullifier.substring(0, 10)}...`);
      throw new Error('Nullifier already used');
    }

    // 2. Compute the wallet address Blake2s hash (uses safe fallback if needed)
    const computedHash = this.computeWalletHash(walletAddress);

    // 3. Verify ZK Proof (Simulated contract verifier logic)
    if (!proof || proof.length === 0) {
      this.addLog('ComplianceShield', 'register_wallet()', 'failed', 'Empty ZK proof');
      throw new Error('ZK Proof Verification failed: empty proof');
    }

    this.addLog('ComplianceShield', 'register_wallet()', 'verifying', 'Invoking UltraHonkVerifier...');

    // 4. Save nullifier and mark wallet eligible
    this.shield.nullifiers.add(nullifier);
    this.shield.eligible.set(walletAddress.trim(), true);

    this.addLog(
      'ComplianceShield',
      'register_wallet()',
      'success',
      `Wallet registered! Wallet: ${walletAddress.substring(0, 8)}... | Nullifier: ${nullifier.substring(0, 10)}...`
    );
  }

  isWalletEligible(walletAddress) {
    return this.shield.eligible.get(walletAddress.trim()) || false;
  }

  // --- RWA TOKEN CONTRACT METHODS ---
  initializeRwaToken(admin, registryAddress, name, symbol) {
    if (this.token.initialized) {
      this.addLog('RwaToken', 'initialize()', 'failed', 'Already initialized');
      throw new Error('Already initialized');
    }
    this.token.admin = admin.trim();
    this.token.registry = registryAddress.trim();
    this.token.name = name;
    this.token.symbol = symbol;
    this.token.initialized = true;

    this.addLog(
      'RwaToken',
      'initialize()',
      'success',
      `Token: ${name} (${symbol}) | Compliance Registry: ${registryAddress.substring(0, 8)}...`
    );
  }

  mint(caller, to, amount) {
    this.verifyAuth(caller, this.token.admin);

    // Dynamic Compliance Check
    const eligible = this.isWalletEligible(to);
    if (!eligible) {
      this.addLog(
        'RwaToken',
        'mint()',
        'failed',
        `Wallet ${to.substring(0, 8)}... is not eligible under ZK-SEP-57 Shield!`
      );
      throw new Error('Wallet is not eligible under ZK-SEP-57 Compliance Shield');
    }

    const currentBal = this.token.balances.get(to.trim()) || 0;
    this.token.balances.set(to.trim(), currentBal + amount);
    this.token.totalSupply += amount;

    this.addLog(
      'RwaToken',
      'mint()',
      'success',
      `Minted ${amount} ${this.token.symbol} to ${to.substring(0, 8)}...`
    );
  }

  transfer(caller, to, amount) {
    const from = caller.trim();
    
    // Dynamic Compliance Checks for both sender and receiver
    if (!this.isWalletEligible(from)) {
      this.addLog(
        'RwaToken',
        'transfer()',
        'failed',
        `Sender ${from.substring(0, 8)}... is not eligible under ZK-SEP-57 Shield!`
      );
      throw new Error('Wallet is not eligible under ZK-SEP-57 Compliance Shield');
    }
    if (!this.isWalletEligible(to)) {
      this.addLog(
        'RwaToken',
        'transfer()',
        'failed',
        `Recipient ${to.substring(0, 8)}... is not eligible under ZK-SEP-57 Shield!`
      );
      throw new Error('Wallet is not eligible under ZK-SEP-57 Compliance Shield');
    }

    const fromBal = this.token.balances.get(from) || 0;
    if (fromBal < amount) {
      this.addLog('RwaToken', 'transfer()', 'failed', 'Insufficient balance');
      throw new Error('Insufficient balance');
    }

    const toBal = this.token.balances.get(to.trim()) || 0;
    this.token.balances.set(from, fromBal - amount);
    this.token.balances.set(to.trim(), toBal + amount);

    this.addLog(
      'RwaToken',
      'transfer()',
      'success',
      `Transferred ${amount} ${this.token.symbol} from ${from.substring(0, 8)}... to ${to.substring(0, 8)}...`
    );
  }

  balanceOf(walletAddress) {
    return this.token.balances.get(walletAddress.trim()) || 0;
  }

  // --- UTILS ---
  verifyAuth(caller, expected) {
    if (!caller || !expected || caller.trim().toLowerCase() !== expected.trim().toLowerCase()) {
      throw new Error('Unauthorized');
    }
  }
}

