import React, { useState, useEffect, useRef } from 'react';
import pkg from 'elliptic';
import blake from 'blakejs';
import { Address, Keypair } from 'stellar-sdk';
import { MockSorobanVM } from './mockSoroban';

const { ec: EC } = pkg;
const ec = new EC('secp256k1');

export default function App() {
  const [vm] = useState(() => new MockSorobanVM());
  const [activeTab, setActiveTab] = useState('registry'); // 'issuer', 'registry', 'token'
  
  // App-wide simulation states
  const [vmLogs, setVmLogs] = useState([]);
  const [shieldState, setShieldState] = useState(vm.shield);
  const [tokenState, setTokenState] = useState(vm.token);

  // Issuer State
  const [issuerKeypair, setIssuerKeypair] = useState(null);
  const [issuerPubHex, setIssuerPubHex] = useState('');
  const [countryCode, setCountryCode] = useState(840); // US
  const [isAccredited, setIsAccredited] = useState(true);
  const [bannedList, setBannedList] = useState([1, 2, 3, 4, 5]); // Default banned country IDs
  
  // User/Client State
  const [userKeypair, setUserKeypair] = useState(null);
  const [userWalletAddress, setUserWalletAddress] = useState('');
  const [credentialSalt, setCredentialSalt] = useState('');
  const [issuedCredential, setIssuedCredential] = useState(null);
  
  // Prover Terminal State
  const [terminalLines, setTerminalLines] = useState([
    { type: 'info', text: 'Noir client-side ZK-Prover initialized.' },
    { type: 'info', text: 'Select a tab or initialize credentials to begin.' }
  ]);
  const [isProving, setIsProving] = useState(false);
  const [generatedProof, setGeneratedProof] = useState(null);
  const terminalEndRef = useRef(null);

  // RWA Token State
  const [rwaAmount, setRwaAmount] = useState(100);
  const [targetRecipient, setTargetRecipient] = useState('');
  const [walletCheckAddr, setWalletCheckAddr] = useState('');
  const [checkResult, setCheckResult] = useState(null);

  // Sync VM Logs and State
  const refreshVmState = () => {
    setVmLogs([...vm.logs]);
    setShieldState({ ...vm.shield });
    setTokenState({ ...vm.token });
  };

  useEffect(() => {
    // Generate initial keys for simulator demo
    const iKey = ec.genKeyPair();
    const uKey = ec.genKeyPair();
    setIssuerKeypair(iKey);
    setUserKeypair(uKey);

    const iPubX = iKey.getPublic().getX().toArrayLike(Buffer, 'be', 32);
    const iPubY = iKey.getPublic().getY().toArrayLike(Buffer, 'be', 32);
    setIssuerPubHex('0x' + Buffer.concat([iPubX, iPubY]).toString('hex'));

    // Generate valid mock Stellar Address with correct checksum
    const mockAddr = Keypair.random().publicKey();
    setUserWalletAddress(mockAddr);


    // Generate a random field-friendly salt
    const saltBytes = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
    saltBytes[0] &= 0x1f; // fit within BN254 scalar field
    setCredentialSalt('0x' + Buffer.from(saltBytes).toString('hex'));
    
    refreshVmState();
  }, []);

  useEffect(() => {
    if (terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [terminalLines]);

  const addTerminalLine = (type, text) => {
    setTerminalLines(prev => [...prev, { type, text }]);
  };

  // --- ACTIONS ---

  // Initialize Contracts
  const handleDeployContracts = () => {
    try {
      vm.reset();
      
      // Initialize Shield
      const vkMockBytes = '0x' + 'ff'.repeat(1760); // 1760 bytes mock UltraHonk VK
      vm.initializeComplianceShield(
        'GDADMIN1234567890COMPLIANCEADMINXXXXXXXXX',
        issuerPubHex,
        vkMockBytes,
        bannedList
      );

      // Initialize RWA Token
      vm.initializeRwaToken(
        'GDADMIN1234567890COMPLIANCEADMINXXXXXXXXX',
        'GDSHIELD1234567890COMPLIANCEREGISTRYXXXX',
        'Compliance Protected Realty Token',
        'CPRT'
      );

      refreshVmState();
      addTerminalLine('success', 'Soroban Smart Contracts successfully initialized!');
    } catch (err) {
      addTerminalLine('error', `Initialization failed: ${err.message}`);
    }
  };

  // Issuer: Sign KYC Credential
  const handleIssueCredential = () => {
    if (!issuerKeypair || !userKeypair) return;
    
    try {
      addTerminalLine('info', 'Compiling KYC Credential fields...');
      
      const userPubX = userKeypair.getPublic().getX().toArrayLike(Buffer, 'be', 32);
      const userPubY = userKeypair.getPublic().getY().toArrayLike(Buffer, 'be', 32);

      // Serialize into 101 bytes: UserPubX (32) + UserPubY (32) + CountryCode (4) + Accredited (1) + Salt (32)
      const credBytes = Buffer.alloc(101);
      userPubX.copy(credBytes, 0);
      userPubY.copy(credBytes, 32);
      credBytes.writeUInt32BE(countryCode, 64);
      credBytes.writeUInt8(isAccredited ? 1 : 0, 68);
      
      const saltBuffer = Buffer.from(credentialSalt.replace('0x', '').padStart(64, '0'), 'hex');
      saltBuffer.copy(credBytes, 69);

      // Compute Blake2s hash of the serialized credential
      const credHash = blake.blake2s(credBytes, null, 32);

      addTerminalLine('info', `Blake2s Credential Hash: 0x${Buffer.from(credHash).toString('hex')}`);

      // Issuer signs the hash
      const sig = issuerKeypair.sign(credHash, { canonical: true });
      const rawSig = Buffer.concat([
        sig.r.toArrayLike(Buffer, 'be', 32),
        sig.s.toArrayLike(Buffer, 'be', 32)
      ]);

      const credentialPayload = {
        userPubkeyX: '0x' + Buffer.from(userPubX).toString('hex'),
        userPubkeyY: '0x' + Buffer.from(userPubY).toString('hex'),
        issuerSignature: '0x' + rawSig.toString('hex'),
        countryCode,
        isAccredited,
        salt: credentialSalt
      };

      setIssuedCredential(credentialPayload);
      addTerminalLine('success', 'KYC Credential successfully signed & issued to client!');
      vm.addLog('KYC Issuer', 'issue_credential()', 'success', `User: ${userWalletAddress.substring(0, 8)}... | Country: ${countryCode}`);
      refreshVmState();
    } catch (err) {
      addTerminalLine('error', `Failed to issue credential: ${err.message}`);
    }
  };

  // Client-Side: Generate ZK Proof using Noir inputs structure
  const handleGenerateProof = async () => {
    if (!issuedCredential) {
      addTerminalLine('error', 'Cannot generate proof: No KYC credential found from the Issuer!');
      return;
    }

    setIsProving(true);
    setGeneratedProof(null);
    setTerminalLines([]);
    
    addTerminalLine('info', 'Initializing Barretenberg WebAssembly prover...');
    await new Promise(r => setTimeout(r, 600));
    
    addTerminalLine('info', 'Loading compiled ACIR constraints (compliance_shield.json)...');
    await new Promise(r => setTimeout(r, 400));
    addTerminalLine('info', 'Found 1,024 arithmetic gates in constraint system.');

    addTerminalLine('info', 'Binding private and public inputs for Noir main()...');
    
    // Calculate simulated target wallet hash
    let computedHashHex = '0x' + '00'.repeat(32);
    try {
      computedHashHex = vm.computeWalletHash(userWalletAddress);
      addTerminalLine('info', `Stellar Address XDR Blake2s hash computed: ${computedHashHex}`);
    } catch (e) {
      addTerminalLine('warning', 'Validating custom address formatting. Using standard wallet stub.');
    }

    const noirInputs = {
      // Private inputs
      user_pubkey_x: issuedCredential.userPubkeyX,
      user_pubkey_y: issuedCredential.userPubkeyY,
      user_signature: '0x' + '00'.repeat(64), // signature verifying possession
      issuer_signature: issuedCredential.issuerSignature,
      issuer_pub_key_x: '0x' + issuerPubHex.substring(2, 66),
      issuer_pub_key_y: '0x' + issuerPubHex.substring(66),
      country_code: issuedCredential.countryCode,
      is_accredited: issuedCredential.isAccredited,
      secret_salt: issuedCredential.salt,

      // Public inputs
      target_wallet_hash: computedHashHex,
      banned_countries: bannedList
    };

    addTerminalLine('info', `Compiling ZK Witness values:\n${JSON.stringify(noirInputs, null, 2)}`);
    await new Promise(r => setTimeout(r, 1200));

    // Verify non-membership check locally as part of proof prep
    const isBanned = bannedList.includes(issuedCredential.countryCode);
    if (isBanned) {
      addTerminalLine('error', `Assertion failure: country_code ${issuedCredential.countryCode} matches a banned country ID!`);
      addTerminalLine('error', 'Prover failed: Private inputs violated circuit constraints!');
      setIsProving(false);
      vm.addLog('Prover', 'generate_proof()', 'failed', `Country code ${issuedCredential.countryCode} is banned!`);
      refreshVmState();
      return;
    }

    addTerminalLine('info', 'Synthesizing UltraHonk proof. Generating polynomial commitments...');
    await new Promise(r => setTimeout(r, 1000));
    
    addTerminalLine('info', 'Running grand product arguments and lookup protocols...');
    await new Promise(r => setTimeout(r, 800));

    // Success Proof Payload
    const dummyProofHex = '0x' + 'ab'.repeat(512); // Mocked 512 bytes proof data
    const nullifierHex = '0x' + blake.blake2s(Buffer.from(issuedCredential.salt), null, 32).toString('hex');
    
    const proofResult = {
      proof: dummyProofHex,
      nullifier: nullifierHex,
      wallet: userWalletAddress,
      publicInputs: {
        walletHash: computedHashHex,
        bannedCountries: bannedList
      }
    };

    setGeneratedProof(proofResult);
    setIsProving(false);
    addTerminalLine('success', '--- Proof Generation Successful! ---');
    addTerminalLine('success', `Nullifier (Blake2s): ${nullifierHex}`);
    addTerminalLine('success', `Proof size: 512 bytes (UltraHonk structure)`);
    addTerminalLine('success', 'Ready to submit proof to ComplianceShield contract.');
  };

  // Submit Proof to Soroban ComplianceShield contract
  const handleSubmitProof = () => {
    if (!generatedProof) return;

    try {
      vm.registerWallet(
        userWalletAddress, // Wallet caller
        generatedProof.proof,
        generatedProof.nullifier,
        generatedProof.wallet
      );
      
      refreshVmState();
      addTerminalLine('success', 'Wallet eligible! registered on ComplianceShield.');
    } catch (err) {
      addTerminalLine('error', `Contract verification failed: ${err.message}`);
    }
  };

  // RWA Token: Mint
  const handleMintTokens = () => {
    try {
      vm.mint(
        'GDADMIN1234567890COMPLIANCEADMINXXXXXXXXX', // Caller (admin)
        userWalletAddress, // Target Wallet
        rwaAmount
      );
      refreshVmState();
    } catch (err) {
      addTerminalLine('error', `Mint transaction failed: ${err.message}`);
    }
  };

  // RWA Token: Transfer
  const handleTransferTokens = () => {
    try {
      vm.transfer(
        userWalletAddress, // Caller (sender)
        targetRecipient, // Receiver
        rwaAmount
      );
      refreshVmState();
    } catch (err) {
      addTerminalLine('error', `Transfer transaction failed: ${err.message}`);
    }
  };

  // Check Wallet Eligibility
  const handleCheckEligibility = () => {
    if (!walletCheckAddr) return;
    const isEligible = vm.isWalletEligible(walletCheckAddr);
    setCheckResult({ address: walletCheckAddr, eligible: isEligible });
  };

  return (
    <div className="dashboard-container">
      {/* HEADER NAVBAR */}
      <header className="dashboard-header">
        <div className="brand-section">
          <span className="brand-icon">🛡️</span>
          <div>
            <h1 className="brand-title">Compliance Shield</h1>
            <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)' }}>
              ZK-SEP-57 Soroban Protocol Showcase
            </p>
          </div>
        </div>

        <nav className="nav-tabs">
          <button 
            className={`nav-tab-btn ${activeTab === 'issuer' ? 'active' : ''}`}
            onClick={() => setActiveTab('issuer')}
          >
            🔑 Issuer Portal
          </button>
          <button 
            className={`nav-tab-btn ${activeTab === 'registry' ? 'active' : ''}`}
            onClick={() => setActiveTab('registry')}
          >
            🧬 User ZK Prover
          </button>
          <button 
            className={`nav-tab-btn ${activeTab === 'token' ? 'active' : ''}`}
            onClick={() => setActiveTab('token')}
          >
            🏢 Asset Ledger (RWA)
          </button>
        </nav>

        <div>
          <button 
            className="btn btn-secondary" 
            style={{ fontSize: '12px', padding: '8px 16px' }}
            onClick={handleDeployContracts}
          >
            ⚡ Restart Contracts
          </button>
        </div>
      </header>

      {/* OVERVIEW PANEL */}
      <div className="glass-panel" style={{ padding: '16px 24px', display: 'flex', gap: '32px', flexWrap: 'wrap' }}>
        <div>
          <span className="form-label">Compliance Shield Registry</span>
          <span style={{ fontSize: '14px', fontFamily: 'var(--font-mono)' }} className={shieldState.initialized ? "glow-text-emerald" : "glow-text-rose"}>
            {shieldState.initialized ? '🟢 ACTIVE (GDSHIELD...)' : '🔴 NOT INITIALIZED'}
          </span>
        </div>
        <div>
          <span className="form-label">RWA Protected Token</span>
          <span style={{ fontSize: '14px', fontFamily: 'var(--font-mono)' }} className={tokenState.initialized ? "glow-text-cyan" : "glow-text-rose"}>
            {tokenState.initialized ? `🔵 ${tokenState.name} (${tokenState.symbol})` : '🔴 NOT INITIALIZED'}
          </span>
        </div>
        <div>
          <span className="form-label">Banned Country IDs</span>
          <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
            {bannedList.map(c => (
              <span key={c} className="badge-country banned">{c}</span>
            ))}
          </div>
        </div>
        <div>
          <span className="form-label">Issuer Public Key</span>
          <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}>
            {issuerPubHex ? `${issuerPubHex.substring(0, 18)}...` : 'Not Loaded'}
          </span>
        </div>
      </div>

      {/* MAIN CONTENT SPLIT */}
      <div className="grid-2">
        {/* LEFT COLUMN: ACTIVE VIEW ACTIONS */}
        <div className="glass-panel" style={{ padding: '24px' }}>
          
          {/* TAB 1: ISSUER PORTAL */}
          {activeTab === 'issuer' && (
            <div>
              <div className="panel-header">
                <h3 className="panel-title">🔑 KYC Authority Credentials Portal</h3>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
                Simulate a verified KYC issuer signing credential metadata for the user wallet. 
                This signed credential will act as the secret input to generate the client-side ZK proof.
              </p>

              <div className="form-group">
                <label className="form-label">User's Country Code (ISO 3166 Numeric)</label>
                <input 
                  type="number" 
                  className="form-input" 
                  value={countryCode} 
                  onChange={(e) => setCountryCode(Number(e.target.value))} 
                />
                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', display: 'block', marginTop: '4px' }}>
                  Demo: USA = 840, Canada = 124, UK = 826. Banned IDs in Shield: {bannedList.join(', ')}.
                </span>
              </div>

              <div className="form-group">
                <label className="form-label">Accreditation Status</label>
                <select 
                  className="form-select" 
                  value={isAccredited ? 'yes' : 'no'} 
                  onChange={(e) => setIsAccredited(e.target.value === 'yes')}
                >
                  <option value="yes">Accredited Investor (True)</option>
                  <option value="no">Non-Accredited Investor (False)</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">Secret Salt (Field Fitting Hex)</label>
                <input 
                  type="text" 
                  className="form-input form-input-mono" 
                  value={credentialSalt} 
                  onChange={(e) => setCredentialSalt(e.target.value)} 
                />
              </div>

              <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleIssueCredential}>
                ✍️ Sign & Issue KYC Credential
              </button>

              {issuedCredential && (
                <div style={{ marginTop: '20px', padding: '16px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                  <span className="form-label">Issued Signature</span>
                  <div style={{ wordBreak: 'break-all', fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--neon-emerald)' }}>
                    {issuedCredential.issuerSignature.substring(0, 80)}...
                  </div>
                  <span className="form-label" style={{ marginTop: '10px', display: 'block' }}>Payload Structure</span>
                  <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', whiteSpace: 'pre' }}>
                    {JSON.stringify({
                      user_pub_x: issuedCredential.userPubkeyX.substring(0, 10) + '...',
                      country: issuedCredential.countryCode,
                      accredited: issuedCredential.isAccredited
                    }, null, 2)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: USER REGISTRATION PORTAL */}
          {activeTab === 'registry' && (
            <div>
              <div className="panel-header">
                <h3 className="panel-title">🧬 ZK-SEP-57 Wallet Compliance Registry</h3>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
                Generate a ZK-Proof client-side to verify your eligibility without exposing your country of origin 
                or credential keys. Submitting the proof will register your wallet as eligible.
              </p>

              <div className="form-group">
                <label className="form-label">Stellar/Soroban Target Wallet Address</label>
                <input 
                  type="text" 
                  className="form-input form-input-mono" 
                  value={userWalletAddress}
                  onChange={(e) => setUserWalletAddress(e.target.value)} 
                />
              </div>

              <div className="form-group" style={{ opacity: issuedCredential ? 1 : 0.5 }}>
                <span className="form-label">Issuer Credential Status</span>
                <div style={{ fontSize: '13px', fontWeight: '600' }}>
                  {issuedCredential ? (
                    <span className="glow-text-emerald">✓ Credential Loaded (Country: {issuedCredential.countryCode})</span>
                  ) : (
                    <span className="glow-text-rose">✗ No Credential found (Go to Issuer tab first)</span>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }}>
                <button 
                  className="btn btn-secondary" 
                  style={{ flex: 1 }} 
                  onClick={handleGenerateProof}
                  disabled={isProving || !issuedCredential}
                >
                  {isProving ? '⚙️ Proving...' : '🧮 Generate ZK Proof'}
                </button>

                <button 
                  className="btn btn-success" 
                  style={{ flex: 1 }} 
                  onClick={handleSubmitProof}
                  disabled={!generatedProof}
                >
                  🚀 Register Wallet
                </button>
              </div>

              {generatedProof && (
                <div style={{ marginTop: '20px', padding: '16px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                  <div className="flex-between">
                    <span className="form-label">Nullifier</span>
                    <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--neon-cyan)' }}>
                      {generatedProof.nullifier.substring(0, 20)}...
                    </span>
                  </div>
                  <div className="flex-between" style={{ marginTop: '8px' }}>
                    <span className="form-label">Prover Status</span>
                    <span className="glow-text-emerald" style={{ fontSize: '12px', fontWeight: 'bold' }}>
                      ✓ Proof Generated
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: ASSET LEDGER (RWA) */}
          {activeTab === 'token' && (
            <div>
              <div className="panel-header">
                <h3 className="panel-title">🏢 Compliance-Protected RWA Token Ledger</h3>
              </div>
              <p style={{ fontSize: '13px', color: 'var(--color-text-secondary)', marginBottom: '20px' }}>
                Demonstrate the enforcement of the compliance shield. The token contract dynamically checks 
                the `ComplianceShield` registry before allowing any mint or transfer actions.
              </p>

              <div className="form-group" style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">Check Wallet Eligibility</label>
                  <input 
                    type="text" 
                    className="form-input form-input-mono" 
                    placeholder="G..." 
                    value={walletCheckAddr}
                    onChange={(e) => setWalletCheckAddr(e.target.value)}
                  />
                </div>
                <button className="btn btn-secondary" onClick={handleCheckEligibility}>Check</button>
              </div>

              {checkResult && (
                <div style={{ marginBottom: '16px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-glass)' }}>
                  <span style={{ fontSize: '13px', display: 'block', wordBreak: 'break-all' }}>
                    Wallet: <span style={{ fontFamily: 'var(--font-mono)' }}>{checkResult.address}</span>
                  </span>
                  <span style={{ fontSize: '14px', fontWeight: 'bold', display: 'block', marginTop: '6px' }} className={checkResult.eligible ? "glow-text-emerald" : "glow-text-rose"}>
                    {checkResult.eligible ? '✓ ELIGIBLE (Allowed to Hold Assets)' : '✗ NON-COMPLIANT (Blocked)'}
                  </span>
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Token Transfer Amount</label>
                <input 
                  type="number" 
                  className="form-input" 
                  value={rwaAmount} 
                  onChange={(e) => setRwaAmount(Number(e.target.value))} 
                />
              </div>

              <div className="form-group">
                <label className="form-label">Recipient Wallet Address (For Transfer)</label>
                <input 
                  type="text" 
                  className="form-input form-input-mono" 
                  placeholder="GD..." 
                  value={targetRecipient}
                  onChange={(e) => setTargetRecipient(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleMintTokens}>
                  🪙 Mint Assets (Admin Only)
                </button>
                <button className="btn btn-success" style={{ flex: 1 }} onClick={handleTransferTokens}>
                  💸 Send Tokens
                </button>
              </div>

              <div style={{ marginTop: '20px', padding: '16px', background: 'rgba(0,0,0,0.15)', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                <span className="form-label">Your Wallet Balance</span>
                <div className="flex-between">
                  <span style={{ fontSize: '24px', fontWeight: '800' }}>
                    {tokenState.initialized ? vm.balanceOf(userWalletAddress) : 0} {tokenState.symbol || 'RWA'}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                    {userWalletAddress.substring(0, 8)}...
                  </span>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* RIGHT COLUMN: TERMINAL & BLOCK EXPLORER LOGS */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
          
          {/* TERMINAL */}
          <div className="terminal-container">
            <div className="terminal-header">
              <div className="terminal-dots">
                <span className="terminal-dot red"></span>
                <span className="terminal-dot yellow"></span>
                <span className="terminal-dot green"></span>
              </div>
              <div>noir_client_prover_stream</div>
            </div>
            <div className="terminal-body">
              {terminalLines.map((line, idx) => (
                <div key={idx} className={`terminal-line ${line.type}`}>
                  &gt; {line.text}
                </div>
              ))}
              <div ref={terminalEndRef}></div>
            </div>
          </div>

          {/* SOROBAN LEDGER LOGS */}
          <div className="glass-panel" style={{ padding: '20px', flex: 1 }}>
            <div className="panel-header" style={{ marginBottom: '12px' }}>
              <h3 className="panel-title">📊 Simulated Soroban Transaction Log</h3>
              <span style={{ fontSize: '11px', color: 'var(--color-text-muted)' }}>Realtime States</span>
            </div>
            
            <div className="ledger-container">
              {vmLogs.map(log => (
                <div key={log.id} className="ledger-card">
                  <div className="ledger-info">
                    <span className={`ledger-tag ${log.contract.toLowerCase().includes('shield') ? 'shield' : 'token'}`}>
                      {log.contract}
                    </span>
                    <span className="ledger-action">{log.action}</span>
                    <span className="ledger-details">{log.details}</span>
                  </div>
                  <div className="ledger-status">
                    <span className={`status-badge ${log.status}`}>
                      {log.status.toUpperCase()}
                    </span>
                  </div>
                </div>
              ))}
              {vmLogs.length === 0 && (
                <div style={{ textAlign: 'center', padding: '20px', color: 'var(--color-text-muted)' }}>
                  No transactions executed yet.
                </div>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
