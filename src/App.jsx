import React, { useState, useEffect, useRef } from 'react';
import pkg from 'elliptic';
import blake from 'blakejs';
import { Address, Keypair, Contract, rpc, scValToNative, nativeToScVal, Networks, TransactionBuilder, Account, xdr } from 'stellar-sdk';
import { MockSorobanVM } from './mockSoroban';
import logoImg from './narthex_logo.png';
import { connectWallet, getWalletAddress, signXdr, isWalletInstalled } from './wallet/freighter';

const { ec: EC } = pkg;
const ec = new EC('secp256k1');

// Helper to convert JS Number/BigInt to ScVal i128 format strictly expected by Soroban
const scvI128 = (value) => {
  const big = BigInt(value);
  const lo = big & 0xffffffffffffffffn;
  const hi = big >> 64n;
  return xdr.ScVal.scvI128(new xdr.Int128Parts({
    lo: new xdr.Uint64([Number(lo & 0xffffffffn), Number(lo >> 32n)]),
    hi: new xdr.Int64([Number(hi & 0xffffffffn), Number(hi >> 32n)])
  }));
};

export default function App() {
  const [vm] = useState(() => new MockSorobanVM());
  const [activeTab, setActiveTab] = useState('registry'); // 'issuer', 'registry', 'token'
  
  // App-wide simulation states
  const [vmLogs, setVmLogs] = useState([]);
  const [shieldState, setShieldState] = useState(vm.shield);
  const [tokenState, setTokenState] = useState(vm.token);

  // Live Testnet Bridge & Freighter States
  const [isTestnetMode, setIsTestnetMode] = useState(false);
  const [freighterConnected, setFreighterConnected] = useState(false);
  const [freighterAddress, setFreighterAddress] = useState('');
  const [testnetShieldContractId, setTestnetShieldContractId] = useState(() => localStorage.getItem('narthex_shield_id') || 'CCBTBY3KSROXEW7JUIULDOFYSF24OUNK3DM2Y5OCQXTE72OU2H77B76H');
  const [testnetTokenContractId, setTestnetTokenContractId] = useState(() => localStorage.getItem('narthex_token_id') || 'CB7VZTPWLEIWSVEEVBYJDN66IXDPTNROU5CH4XI4MXC3GFWTM7JDRGKF');
  const [testnetLoading, setTestnetLoading] = useState(false);
  const [shieldNeedsInit, setShieldNeedsInit] = useState(false);
  const [onchainBalance, setOnchainBalance] = useState('0');

  // Manual sign / sandbox fallback states
  const [isManualWalletMode, setIsManualWalletMode] = useState(false);
  const [manualAddressInput, setManualAddressInput] = useState('');
  const [pendingTxXdr, setPendingTxXdr] = useState('');
  const [signedXdrInput, setSignedXdrInput] = useState('');
  const [showXdrModal, setShowXdrModal] = useState(false);

  // Banned Countries Admin input
  const [bannedInputString, setBannedInputString] = useState('1, 2, 3, 4, 5');

  // ZK Constraints Panel Collapsible State
  const [showZkConstraints, setShowZkConstraints] = useState(false);

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
    const generatedSalt = '0x' + Buffer.from(saltBytes).toString('hex');
    setCredentialSalt(generatedSalt);

    // Auto-deploy/initialize contracts on load
    try {
      const vkMockBytes = '0x' + 'ff'.repeat(1760);
      const issuerPubString = '0x' + Buffer.concat([iPubX, iPubY]).toString('hex');
      
      vm.initializeComplianceShield(
        'GDADMIN1234567890COMPLIANCEADMINXXXXXXXXX',
        issuerPubString,
        vkMockBytes,
        [1, 2, 3, 4, 5]
      );

      vm.initializeRwaToken(
        'GDADMIN1234567890COMPLIANCEADMINXXXXXXXXX',
        'GDSHIELD1234567890COMPLIANCEREGISTRYXXXX',
        'Compliance Protected Realty Token',
        'CPRT'
      );
    } catch (e) {
      console.error("Auto-initialization failed:", e);
    }
    
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

  // --- LOCALSTORAGE SYNC ---
  const updateShieldContractId = (val) => {
    setTestnetShieldContractId(val);
    localStorage.setItem('narthex_shield_id', val);
  };

  const updateTokenContractId = (val) => {
    setTestnetTokenContractId(val);
    localStorage.setItem('narthex_token_id', val);
  };

  // --- FREIGHTER CONNECTION ---
  const connectFreighter = async () => {
    addTerminalLine('info', 'Searching for Freighter wallet extension...');
    
    try {
      const installed = await isWalletInstalled();
      if (!installed) {
        addTerminalLine('error', 'Freighter extension not detected.');
        addTerminalLine('warning', 'Please ensure the Freighter extension is active or allow it permission to run on this site.');
        return;
      }

      setTestnetLoading(true);
      const address = await connectWallet();
      setFreighterAddress(address);
      setFreighterConnected(true);
      setUserWalletAddress(address);
      addTerminalLine('success', `Freighter Connected! Address: ${address}`);
    } catch (e) {
      addTerminalLine('error', `Connection failed: ${e.message || e}`);
    } finally {
      setTestnetLoading(false);
    }
  };

  // --- ON-CHAIN TRANSACTIONS HANDLER ---
  const executeSorobanTransaction = async (contractId, functionName, scArgs) => {
    const installed = await isWalletInstalled();
    const useManual = isManualWalletMode || !installed;
    
    const server = new rpc.Server('https://soroban-testnet.stellar.org');
    
    let activeAddress = '';
    if (isManualWalletMode) {
      activeAddress = manualAddressInput;
    } else {
      try {
        activeAddress = freighterAddress || await getWalletAddress();
      } catch (e) {
        if (!installed) {
          addTerminalLine('warning', 'Freighter not detected. Falling back to Manual mode.');
        } else {
          addTerminalLine('error', `Could not retrieve wallet address: ${e.message || e}`);
        }
      }
    }
    
    if (!activeAddress) {
      throw new Error("No active wallet address. Please connect Freighter or toggle Manual Wallet Input.");
    }
    
    addTerminalLine('info', `Building real on-chain transaction for '${functionName}'...`);
    
    const account = await server.getAccount(activeAddress.trim());
    const contract = new Contract(contractId.trim());
    
    let tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: Networks.TESTNET
    })
    .addOperation(contract.call(functionName, ...scArgs))
    .setTimeout(60)
    .build();
    
    addTerminalLine('info', 'Simulating transaction to construct footprints & allocate storage...');
    tx = await server.prepareTransaction(tx);
    const txXdr = tx.toXDR();
    
    if (useManual) {
      addTerminalLine('warning', 'Manual mode active: prepared transaction generated. Please sign this transaction manually.');
      setPendingTxXdr(txXdr);
      setShowXdrModal(true);
      throw new Error("Manual signing required. Please use the XDR panel.");
    }
    
    addTerminalLine('info', 'Prompting signature from Freighter extension...');
    let signedXdr;
    try {
      signedXdr = await signXdr(txXdr, Networks.TESTNET);
    } catch (e) {
      addTerminalLine('error', `Signing failed: ${e.message || e}`);
      throw e;
    }
    
    const signedTx = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    
    addTerminalLine('info', 'Broadcasting transaction to Stellar Testnet...');
    const response = await server.sendTransaction(signedTx);
    
    if (response.status === 'ERROR') {
      throw new Error(`RPC submit error: ${JSON.stringify(response.errorResult)}`);
    }
    
    const txHash = response.hash;
    addTerminalLine('info', `Transaction submitted. Tx Hash: ${txHash.substring(0, 16)}...`);
    addTerminalLine('info', 'Waiting for block consensus...');
    
    for (let i = 0; i < 20; i++) {
      const txStatus = await server.getTransaction(txHash);
      if (txStatus.status === 'SUCCESS') {
        addTerminalLine('success', `Tx confirmed successfully!`);
        return { success: true, hash: txHash };
      } else if (txStatus.status === 'FAILED') {
        throw new Error('Transaction execution failed.');
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    
    throw new Error('Polling timed out.');
  };

  // --- MANUAL XDR SUBMISSION ---
  const handleSubmitSignedXdr = async () => {
    if (!signedXdrInput) {
      alert("Please paste the signed XDR first.");
      return;
    }
    setTestnetLoading(true);
    addTerminalLine('info', 'Submitting manually signed transaction to Stellar Testnet...');
    try {
      const server = new rpc.Server('https://soroban-testnet.stellar.org');
      const signedTx = TransactionBuilder.fromXDR(signedXdrInput.trim(), Networks.TESTNET);
      
      const response = await server.sendTransaction(signedTx);
      if (response.status === 'ERROR') {
        throw new Error(`RPC submit error: ${JSON.stringify(response.errorResult)}`);
      }
      
      const txHash = response.hash;
      addTerminalLine('info', `Transaction submitted. Tx Hash: ${txHash.substring(0, 16)}...`);
      addTerminalLine('info', 'Waiting for block consensus...');
      
      let confirmed = false;
      for (let i = 0; i < 20; i++) {
        const txStatus = await server.getTransaction(txHash);
        if (txStatus.status === 'SUCCESS') {
          addTerminalLine('success', `Manually signed transaction confirmed successfully!`);
          confirmed = true;
          setShowXdrModal(false);
          setSignedXdrInput('');
          setPendingTxXdr('');
          break;
        } else if (txStatus.status === 'FAILED') {
          throw new Error('Transaction execution failed.');
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!confirmed) {
        throw new Error("Polling timed out.");
      }
      
      fetchOnchainBalance();
      refreshVmState();
    } catch (err) {
      addTerminalLine('error', `Submission failed: ${err.message}`);
    } finally {
      setTestnetLoading(false);
    }
  };

  // --- PROOF UPLOAD HANDLER ---
  const handleProofFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        if (!data.proof_hex || !data.nullifier) {
          addTerminalLine('error', 'Invalid proof_summary.json structure: missing proof_hex or nullifier.');
          return;
        }
        setGeneratedProof({
          proof: data.proof_hex,
          nullifier: data.nullifier,
          wallet: data.target_wallet || userWalletAddress,
          publicInputs: {
            walletHash: data.wallet_hash,
            bannedCountries: data.banned_countries
          }
        });
        if (data.target_wallet) {
          setUserWalletAddress(data.target_wallet);
        }
        addTerminalLine('success', 'Real ZK-Proof summary successfully uploaded!');
        addTerminalLine('info', `Nullifier: ${data.nullifier}`);
        addTerminalLine('info', `Target Wallet Address: ${data.target_wallet}`);
      } catch (err) {
        addTerminalLine('error', `Failed to parse proof JSON file: ${err.message}`);
      }
    };
    reader.readAsText(file);
  };

  // Admin: Update Banned Countries in Contract
  const handleUpdateBannedCountries = async () => {
    try {
      const parsedList = bannedInputString
        .split(',')
        .map(s => Number(s.trim()))
        .filter(n => !isNaN(n));
      
      if (parsedList.length !== 5) {
        addTerminalLine('error', 'Update failed: Banned list must contain exactly 5 numeric IDs.');
        return;
      }
      
      if (isTestnetMode) {
        if (!testnetShieldContractId) {
          addTerminalLine('error', 'Please enter a valid ComplianceShield Contract ID.');
          return;
        }
        setTestnetLoading(true);
        const scArgs = [
          nativeToScVal(parsedList.map(n => nativeToScVal(n, { type: 'u32' })))
        ];
        const txRes = await executeSorobanTransaction(testnetShieldContractId, 'update_banned_countries', scArgs);
        setBannedList(parsedList);
        addTerminalLine('success', `On-chain updated banned countries! Explorer: https://stellar.expert/explorer/testnet/tx/${txRes.hash}`);
        vm.addLog('ComplianceShield', 'update_banned_countries()', 'success', `On-Chain Tx: ${txRes.hash.substring(0,8)}...`);
      } else {
        vm.updateBannedCountries(
          'GDADMIN1234567890COMPLIANCEADMINXXXXXXXXX', // Admin caller
          parsedList
        );
        setBannedList(parsedList);
        addTerminalLine('success', `Banned country IDs successfully updated to: [${parsedList.join(', ')}]`);
      }
      refreshVmState();
    } catch (err) {
      addTerminalLine('error', `Contract update failed: ${err.message}`);
    } finally {
      setTestnetLoading(false);
    }
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
    if (isTestnetMode) {
      addTerminalLine('info', 'Please generate ZK Proof locally to bypass browser constraints.');
      addTerminalLine('info', `CLI command: node scripts/prove.js ${userWalletAddress}`);
      return;
    }

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
    
    let computedHashHex = '0x' + '00'.repeat(32);
    try {
      computedHashHex = vm.computeWalletHash(userWalletAddress);
      addTerminalLine('info', `Stellar Address XDR Blake2s hash computed: ${computedHashHex}`);
    } catch (e) {
      addTerminalLine('warning', 'Validating custom address formatting. Using standard wallet stub.');
    }

    const noirInputs = {
      user_pubkey_x: issuedCredential.userPubkeyX,
      user_pubkey_y: issuedCredential.userPubkeyY,
      user_signature: '0x' + '00'.repeat(64),
      issuer_signature: issuedCredential.issuerSignature,
      issuer_pub_key_x: '0x' + issuerPubHex.substring(2, 66),
      issuer_pub_key_y: '0x' + issuerPubHex.substring(66),
      country_code: issuedCredential.countryCode,
      is_accredited: issuedCredential.isAccredited,
      secret_salt: issuedCredential.salt,
      target_wallet_hash: computedHashHex,
      banned_countries: bannedList
    };

    addTerminalLine('info', `Compiling ZK Witness values:\n${JSON.stringify(noirInputs, null, 2)}`);
    await new Promise(r => setTimeout(r, 1200));

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

    const dummyProofHex = '0x' + 'ab'.repeat(512);
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

  // Read-only check: is the contract initialized?
  const checkIsContractInitialized = async (contractId) => {
    try {
      const server = new rpc.Server('https://soroban-testnet.stellar.org');
      const contract = new Contract(contractId.trim());
      const tempKeypair = Keypair.random();
      const account = new Account(tempKeypair.publicKey(), '0');

      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET
      })
      .addOperation(
        contract.call('is_initialized')
      )
      .setTimeout(30)
      .build();

      const simResponse = await server.simulateTransaction(tx);
      if (simResponse.result && simResponse.result.retval) {
        return scValToNative(simResponse.result.retval);
      }
      return false;
    } catch (e) {
      console.warn("Failed to check is_initialized, assuming false:", e);
      return false;
    }
  };

  // Initialize ComplianceShield Contract on-chain
  const handleInitializeComplianceShield = async () => {
    if (!isTestnetMode || !testnetShieldContractId) return;

    try {
      setTestnetLoading(true);
      addTerminalLine('info', 'Preparing initialize transaction on-chain...');

      const installed = await isWalletInstalled();
      let activeWallet = '';
      if (isManualWalletMode) {
        activeWallet = manualAddressInput;
      } else {
        activeWallet = freighterAddress || await getWalletAddress();
      }

      if (!activeWallet) {
        throw new Error("No connected wallet to set as admin.");
      }

      // Mock UltraHonk VK fallback (1760 bytes)
      const vkMockBytes = '0x' + 'ff'.repeat(1760);
      
      const iPubX = issuerKeypair.getPublic().getX().toArrayLike(Buffer, 'be', 32);
      const iPubY = issuerKeypair.getPublic().getY().toArrayLike(Buffer, 'be', 32);
      const issuerPubBytes = Buffer.concat([iPubX, iPubY]);

      const scArgs = [
        nativeToScVal(new Address(activeWallet.trim())), // admin
        nativeToScVal(issuerPubBytes), // issuer_pubkey
        nativeToScVal(Buffer.from(vkMockBytes.replace('0x', ''), 'hex')), // vk
        nativeToScVal(bannedList.map(n => nativeToScVal(n, { type: 'u32' }))) // banned_countries
      ];

      const txRes = await executeSorobanTransaction(testnetShieldContractId, 'initialize', scArgs);
      addTerminalLine('success', `Initialized ComplianceShield on-chain! Explorer: https://stellar.expert/explorer/testnet/tx/${txRes.hash}`);
      vm.addLog('ComplianceShield', 'initialize()', 'success', `On-Chain Tx: ${txRes.hash.substring(0,8)}...`);
      
      setShieldNeedsInit(false);
      addTerminalLine('info', 'Verification registry initialized. Proceeding to register wallet...');
      
      // Auto-continue to handleSubmitProof
      await handleSubmitProof();
    } catch (err) {
      addTerminalLine('error', `Contract initialization failed: ${err.message}`);
    } finally {
      setTestnetLoading(false);
    }
  };

  // Submit Proof to Soroban ComplianceShield contract
  const handleSubmitProof = async () => {
    if (!generatedProof) return;

    try {
      if (isTestnetMode) {
        if (!testnetShieldContractId) {
          addTerminalLine('error', 'Please enter a ComplianceShield Contract ID.');
          return;
        }
        setTestnetLoading(true);

        // Check if contract is initialized
        const isInit = await checkIsContractInitialized(testnetShieldContractId);
        if (!isInit) {
          addTerminalLine('error', 'Contract not initialized.');
          setShieldNeedsInit(true);
          setTestnetLoading(false);
          return;
        }

        addTerminalLine('info', 'Preparing register_wallet invocation on-chain...');

        const proofBuffer = Buffer.from(generatedProof.proof.replace('0x', ''), 'hex');
        const nullifierBuffer = Buffer.from(generatedProof.nullifier.replace('0x', ''), 'hex');
        
        const scArgs = [
          nativeToScVal(proofBuffer),
          nativeToScVal(nullifierBuffer),
          nativeToScVal(new Address(generatedProof.wallet.trim()))
        ];

        const txRes = await executeSorobanTransaction(testnetShieldContractId, 'register_wallet', scArgs);
        
        vm.shield.eligible.set(generatedProof.wallet.trim(), true);
        refreshVmState();
        
        addTerminalLine('success', `Registered user wallet on-chain! Explorer: https://stellar.expert/explorer/testnet/tx/${txRes.hash}`);
        vm.addLog('ComplianceShield', 'register_wallet()', 'success', `On-Chain Tx: ${txRes.hash.substring(0,8)}...`);
      } else {
        vm.registerWallet(
          userWalletAddress, // Wallet caller
          generatedProof.proof,
          generatedProof.nullifier,
          generatedProof.wallet
        );
        refreshVmState();
        addTerminalLine('success', 'Wallet eligible! registered on ComplianceShield.');
      }
    } catch (err) {
      addTerminalLine('error', `Contract verification failed: ${err.message}`);
    } finally {
      setTestnetLoading(false);
    }
  };

  // RWA Token: Mint
  const handleMintTokens = async () => {
    try {
      if (isTestnetMode) {
        if (!testnetTokenContractId) {
          addTerminalLine('error', 'Please enter the RwaToken Contract ID.');
          return;
        }
        setTestnetLoading(true);
        addTerminalLine('info', 'Preparing mint invocation on-chain...');

        const scArgs = [
          nativeToScVal(new Address(userWalletAddress.trim())),
          scvI128(rwaAmount)
        ];

        const txRes = await executeSorobanTransaction(testnetTokenContractId, 'mint', scArgs);
        
        addTerminalLine('success', `Minted RWA assets on-chain! Explorer: https://stellar.expert/explorer/testnet/tx/${txRes.hash}`);
        vm.addLog('RwaToken', 'mint()', 'success', `On-Chain Tx: ${txRes.hash.substring(0,8)}...`);
        fetchOnchainBalance();
      } else {
        vm.mint(
          'GDADMIN1234567890COMPLIANCEADMINXXXXXXXXX', // Caller (admin)
          userWalletAddress, // Target Wallet
          rwaAmount
        );
      }
      refreshVmState();
    } catch (err) {
      addTerminalLine('error', `Mint transaction failed: ${err.message}`);
    } finally {
      setTestnetLoading(false);
    }
  };

  // RWA Token: Transfer
  const handleTransferTokens = async () => {
    try {
      if (isTestnetMode) {
        if (!testnetTokenContractId) {
          addTerminalLine('error', 'Please enter the RwaToken Contract ID.');
          return;
        }
        setTestnetLoading(true);
        addTerminalLine('info', 'Preparing transfer invocation on-chain...');

        const scArgs = [
          nativeToScVal(new Address(userWalletAddress.trim())),
          nativeToScVal(new Address(targetRecipient.trim())),
          scvI128(rwaAmount)
        ];

        const txRes = await executeSorobanTransaction(testnetTokenContractId, 'transfer', scArgs);
        
        addTerminalLine('success', `Transferred assets on-chain! Explorer: https://stellar.expert/explorer/testnet/tx/${txRes.hash}`);
        vm.addLog('RwaToken', 'transfer()', 'success', `On-Chain Tx: ${txRes.hash.substring(0,8)}...`);
        fetchOnchainBalance();
      } else {
        vm.transfer(
          userWalletAddress, // Caller (sender)
          targetRecipient, // Receiver
          rwaAmount
        );
      }
      refreshVmState();
    } catch (err) {
      addTerminalLine('error', `Transfer transaction failed: ${err.message}`);
    } finally {
      setTestnetLoading(false);
    }
  };

  // Check Wallet Eligibility
  const handleCheckEligibility = async () => {
    if (!walletCheckAddr) return;
    
    if (isTestnetMode) {
      if (!testnetShieldContractId) {
        addTerminalLine('error', 'Please enter the ComplianceShield Contract ID.');
        return;
      }
      setTestnetLoading(true);
      try {
        const server = new rpc.Server('https://soroban-testnet.stellar.org');
        const contract = new Contract(testnetShieldContractId.trim());
        const targetAddr = new Address(walletCheckAddr.trim());

        const tempKeypair = Keypair.random();
        const account = new Account(tempKeypair.publicKey(), '0');

        const tx = new TransactionBuilder(account, {
          fee: '100',
          networkPassphrase: Networks.TESTNET
        })
        .addOperation(
          contract.call('is_wallet_eligible', nativeToScVal(targetAddr))
        )
        .setTimeout(30)
        .build();

        const simResponse = await server.simulateTransaction(tx);
        if (simResponse.result && simResponse.result.retval) {
          const isEligible = scValToNative(simResponse.result.retval);
          setCheckResult({ address: walletCheckAddr, eligible: isEligible });
        } else {
          throw new Error('Simulation result empty');
        }
      } catch (err) {
        addTerminalLine('error', `Failed to check eligibility on-chain: ${err.message}`);
      } finally {
        setTestnetLoading(false);
      }
    } else {
      const isEligible = vm.isWalletEligible(walletCheckAddr);
      setCheckResult({ address: walletCheckAddr, eligible: isEligible });
    }
  };

  // Fetch On-chain Balance
  const fetchOnchainBalance = async () => {
    if (!isTestnetMode || !testnetTokenContractId || !userWalletAddress) return;
    try {
      const server = new rpc.Server('https://soroban-testnet.stellar.org');
      const contract = new Contract(testnetTokenContractId.trim());
      const targetAddr = new Address(userWalletAddress.trim());

      const tempKeypair = Keypair.random();
      const account = new Account(tempKeypair.publicKey(), '0');

      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: Networks.TESTNET
      })
      .addOperation(
        contract.call('balance', nativeToScVal(targetAddr))
      )
      .setTimeout(30)
      .build();

      const simResponse = await server.simulateTransaction(tx);
      if (simResponse.result && simResponse.result.retval) {
        const bal = scValToNative(simResponse.result.retval);
        setOnchainBalance(bal.toString());
      }
    } catch (e) {
      console.warn("Failed to fetch on-chain balance:", e);
    }
  };

  useEffect(() => {
    if (isTestnetMode) {
      fetchOnchainBalance();
    }
  }, [isTestnetMode, testnetTokenContractId, userWalletAddress]);

  return (
    <div className="dashboard-container">
      {/* HEADER NAVBAR */}
      <header className="dashboard-header">
        <div className="brand-section" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <img src={logoImg} alt="Narthex Logo" style={{ height: '38px', width: '38px', borderRadius: '8px', border: '1px solid var(--border-glass)' }} />
          <div>
            <h1 className="brand-title" style={{ fontSize: '20px', fontWeight: '800', letterSpacing: '0.5px', background: 'linear-gradient(to right, var(--neon-cyan), #a855f7)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', margin: 0 }}>Narthex</h1>
            <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', margin: '2px 0 0 0' }}>
              ZK-SEP-57 Compliance Shield on Soroban
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

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }} className="header-actions">
          <button 
            className={`btn ${isTestnetMode ? 'btn-primary' : 'btn-secondary'}`}
            style={{ fontSize: '12px', padding: '8px 16px' }}
            onClick={() => {
              setIsTestnetMode(!isTestnetMode);
              addTerminalLine('info', `Switched mode to: ${!isTestnetMode ? 'Stellar Testnet (On-Chain)' : 'Simulated Soroban VM'}`);
            }}
          >
            {isTestnetMode ? '🌐 Live Testnet' : '💻 Simulator'}
          </button>
          
          {isTestnetMode && !freighterConnected && (
            <button 
              className="btn btn-success" 
              style={{ fontSize: '12px', padding: '8px 16px' }}
              onClick={connectFreighter}
            >
              🔌 Connect Freighter
            </button>
          )}

          {isTestnetMode && freighterConnected && (
            <span className="badge-country" style={{ borderColor: 'var(--neon-emerald)', color: 'var(--neon-emerald)', fontSize: '11px' }}>
              🟢 {freighterAddress.substring(0,6)}...{freighterAddress.substring(freighterAddress.length-4)}
            </span>
          )}

          {isTestnetMode && (
            <button 
              className={`btn ${isManualWalletMode ? 'btn-primary' : 'btn-secondary'}`}
              style={{ fontSize: '12px', padding: '8px 16px' }}
              onClick={() => {
                setIsManualWalletMode(!isManualWalletMode);
                if (!isManualWalletMode) {
                  addTerminalLine('info', 'Manual wallet mode activated. Paste your G... address below in the Active Wallet Address card.');
                } else {
                  addTerminalLine('info', 'Manual wallet mode deactivated.');
                }
              }}
            >
              ✍️ {isManualWalletMode ? 'Manual Input Mode' : 'Use Manual Address'}
            </button>
          )}

          <button 
            className="btn btn-secondary" 
            style={{ fontSize: '12px', padding: '8px 16px' }}
            onClick={handleDeployContracts}
            disabled={isTestnetMode}
          >
            ⚡ Restart VM
          </button>
        </div>
      </header>

      {/* OVERVIEW PANEL */}
      <div className="glass-panel overview-grid" style={{ padding: '16px 24px' }}>
        <div>
          <span className="form-label">Compliance Shield Registry</span>
          {isTestnetMode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input 
                  type="text" 
                  placeholder="Paste contract ID..." 
                  className="form-input form-input-mono"
                  style={{ padding: '4px 8px', fontSize: '11px', flex: 1 }}
                  value={testnetShieldContractId}
                  onChange={(e) => updateShieldContractId(e.target.value)}
                />
                <button 
                  onClick={() => updateShieldContractId('CCBTBY3KSROXEW7JUIULDOFYSF24OUNK3DM2Y5OCQXTE72OU2H77B76H')}
                  className="btn-secondary"
                  style={{ padding: '2px 8px', fontSize: '10px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg-glass)', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  Reset
                </button>
              </div>
              <span style={{ fontSize: '11px' }} className={testnetShieldContractId ? "glow-text-cyan" : "glow-text-rose"}>
                {testnetShieldContractId ? '🌐 ON-CHAIN CONTRACT' : '🔴 ID REQUIRED'}
              </span>
            </div>
          ) : (
            <span style={{ fontSize: '14px', fontFamily: 'var(--font-mono)' }} className={shieldState.initialized ? "glow-text-emerald" : "glow-text-rose"}>
              {shieldState.initialized ? '🟢 ACTIVE (GDSHIELD...)' : '🔴 NOT INITIALIZED'}
            </span>
          )}
        </div>
        <div>
          <span className="form-label">RWA Protected Token</span>
          {isTestnetMode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input 
                  type="text" 
                  placeholder="Paste contract ID..." 
                  className="form-input form-input-mono"
                  style={{ padding: '4px 8px', fontSize: '11px', flex: 1 }}
                  value={testnetTokenContractId}
                  onChange={(e) => updateTokenContractId(e.target.value)}
                />
                <button 
                  onClick={() => updateTokenContractId('CB7VZTPWLEIWSVEEVBYJDN66IXDPTNROU5CH4XI4MXC3GFWTM7JDRGKF')}
                  className="btn-secondary"
                  style={{ padding: '2px 8px', fontSize: '10px', borderRadius: '4px', border: '1px solid var(--border)', background: 'var(--bg-glass)', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  Reset
                </button>
              </div>
              <span style={{ fontSize: '11px' }} className={testnetTokenContractId ? "glow-text-cyan" : "glow-text-rose"}>
                {testnetTokenContractId ? '🌐 ON-CHAIN TOKEN' : '🔴 ID REQUIRED'}
              </span>
            </div>
          ) : (
            <span style={{ fontSize: '14px', fontFamily: 'var(--font-mono)' }} className={tokenState.initialized ? "glow-text-cyan" : "glow-text-rose"}>
              {tokenState.initialized ? `🔵 ${tokenState.name} (${tokenState.symbol})` : '🔴 NOT INITIALIZED'}
            </span>
          )}
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
          <span className="form-label">Active Wallet Address</span>
          <span style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', wordBreak: 'break-all', display: 'block' }}>
            {isTestnetMode ? (
              isManualWalletMode ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <input 
                    type="text" 
                    placeholder="Paste G... address" 
                    className="form-input form-input-mono"
                    style={{ padding: '4px 8px', fontSize: '11px' }}
                    value={manualAddressInput}
                    onChange={(e) => {
                      setManualAddressInput(e.target.value);
                      setUserWalletAddress(e.target.value); // Sync target wallet
                    }}
                  />
                  <span style={{ fontSize: '10px', color: 'var(--neon-cyan)', fontWeight: 'bold' }}>✍️ MANUAL WALLET ACTIVE</span>
                </div>
              ) : freighterConnected ? (
                <span className="glow-text-emerald" style={{ wordBreak: 'break-all' }}>🟢 {freighterAddress}</span>
              ) : (
                <button 
                  className="btn btn-secondary" 
                  style={{ padding: '6px 12px', fontSize: '11px', height: 'auto', display: 'inline-flex', marginTop: '4px', width: '100%', justifyContent: 'center' }}
                  onClick={connectFreighter}
                >
                  🔌 Connect Freighter
                </button>
              )
            ) : (
              userWalletAddress || 'Not Loaded'
            )}
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

              {/* Dynamic Banned Country Configurator */}
              <div className="form-group" style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid var(--border-glass)' }}>
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>🚫</span> Update Banned Countries on Registry (Admin)
                </label>
                <div style={{ display: 'flex', gap: '8px' }} className="button-group-responsive">
                  <input 
                    type="text" 
                    className="form-input form-input-mono" 
                    style={{ flex: 1 }}
                    value={bannedInputString} 
                    onChange={(e) => setBannedInputString(e.target.value)} 
                  />
                  <button 
                    className="btn btn-secondary" 
                    style={{ fontSize: '13px', whiteSpace: 'nowrap' }}
                    onClick={handleUpdateBannedCountries}
                    disabled={testnetLoading}
                  >
                    Update Shield
                  </button>
                </div>
                <span style={{ fontSize: '11px', color: 'var(--color-text-muted)', display: 'block', marginTop: '4px' }}>
                  Enter exactly 5 comma-separated numeric IDs. Admin signature will authenticate this call.
                </span>
              </div>
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

              {isTestnetMode && (
                <div className="form-group" style={{ border: '1px dashed var(--border-active)', padding: '16px', borderRadius: '12px', background: 'rgba(139, 92, 246, 0.05)', marginBottom: '20px' }}>
                  <label className="form-label" style={{ color: 'var(--neon-violet)', fontWeight: 'bold' }}>📤 Upload ZK Proof Summary (On-Chain Mode)</label>
                  <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '12px', lineHeight: '1.4' }}>
                    Generate a real proof locally using your Freighter address:<br/>
                    <code style={{ background: '#000', padding: '4px 8px', borderRadius: '4px', display: 'inline-block', marginTop: '6px', fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                      node scripts/prove.js {userWalletAddress || 'G...'}
                    </code>
                  </p>
                  <input 
                    type="file" 
                    accept=".json"
                    className="form-input" 
                    style={{ fontSize: '13px' }}
                    onChange={handleProofFileUpload} 
                  />
                  {generatedProof && generatedProof.wallet && (
                    <span style={{ fontSize: '11px', color: 'var(--neon-emerald)', display: 'block', marginTop: '6px' }}>
                      ✓ Proof loaded for wallet: {generatedProof.wallet.substring(0,12)}...
                    </span>
                  )}
                </div>
              )}

              {!isTestnetMode && (
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
              )}

              {shieldNeedsInit && (
                <div style={{ marginTop: '20px', padding: '16px', background: 'rgba(244,63,94,0.1)', borderRadius: '8px', border: '1px solid rgba(244,63,94,0.3)', marginBottom: '20px' }}>
                  <p style={{ color: 'var(--neon-rose)', fontSize: '13px', marginBottom: '12px', fontWeight: 600 }}>
                    ⚠️ ComplianceShield contract is not initialized on-chain.
                  </p>
                  <button 
                    className="btn btn-success" 
                    style={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
                    onClick={handleInitializeComplianceShield}
                    disabled={testnetLoading}
                  >
                    ⚙️ Initialize Contract (Set current wallet as admin)
                  </button>
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px', marginTop: '20px' }} className="button-group-responsive">
                <button 
                  className="btn btn-secondary" 
                  style={{ flex: 1 }} 
                  onClick={handleGenerateProof}
                  disabled={isProving || (!isTestnetMode && !issuedCredential)}
                >
                  {isProving ? '⚙️ Proving...' : isTestnetMode ? '🧮 Offline CLI Prover Mode' : '🧮 Generate ZK Proof'}
                </button>

                <button 
                  className="btn btn-success" 
                  style={{ flex: 1 }} 
                  onClick={handleSubmitProof}
                  disabled={!generatedProof || testnetLoading}
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
                      ✓ Proof Loaded
                    </span>
                  </div>
                </div>
              )}

              {/* ZK Circuit Constraints Visualizer */}
              <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border-glass)' }}>
                <button 
                  className="btn btn-secondary" 
                  style={{ width: '100%', justifyContent: 'space-between', padding: '10px 14px', fontSize: '13px' }}
                  onClick={() => setShowZkConstraints(!showZkConstraints)}
                >
                  <span>📊 {showZkConstraints ? 'Hide' : 'Show'} ZK Circuit Constraints Math</span>
                  <span>{showZkConstraints ? '▲' : '▼'}</span>
                </button>
                
                {showZkConstraints && (
                  <div style={{ marginTop: '12px', padding: '16px', background: 'rgba(0,0,0,0.3)', borderRadius: '8px', border: '1px solid var(--border-glass)', fontSize: '12px', lineHeight: '1.6' }}>
                    <h4 style={{ color: 'var(--neon-cyan)', marginBottom: '8px', fontWeight: '600' }}>Verified Constraints (Noir Circuits):</h4>
                    <ul style={{ listStyleType: 'disc', paddingLeft: '20px', display: 'flex', flexDirection: 'column', gap: '8px', color: 'var(--color-text-secondary)' }}>
                      <li>
                        <strong style={{ color: 'var(--color-text-primary)' }}>Ownership Verification:</strong>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', marginTop: '2px', background: 'rgba(0,0,0,0.2)', padding: '4px 8px', borderRadius: '4px' }}>
                          verify_signature(user_pubkey, user_sig, blake2s(target_wallet)) == true
                        </div>
                      </li>
                      <li>
                        <strong style={{ color: 'var(--color-text-primary)' }}>Issuer Credential Authenticity:</strong>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', marginTop: '2px', background: 'rgba(0,0,0,0.2)', padding: '4px 8px', borderRadius: '4px' }}>
                          verify_signature(issuer_pubkey, issuer_sig, blake2s(cred_payload)) == true
                        </div>
                      </li>
                      <li>
                        <strong style={{ color: 'var(--color-text-primary)' }}>Exclusion Check:</strong>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', marginTop: '2px', background: 'rgba(0,0,0,0.2)', padding: '4px 8px', borderRadius: '4px' }}>
                          for each banned in banned_countries: assert(country_code != banned)
                        </div>
                      </li>
                      <li>
                        <strong style={{ color: 'var(--color-text-primary)' }}>Unique Nullifier:</strong>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', marginTop: '2px', background: 'rgba(0,0,0,0.2)', padding: '4px 8px', borderRadius: '4px' }}>
                          nullifier = blake2s(user_pubkey_x, user_pubkey_y, salt)
                        </div>
                      </li>
                    </ul>
                  </div>
                )}
              </div>
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

              <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }} className="button-group-responsive">
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
                <button className="btn btn-secondary" onClick={handleCheckEligibility} disabled={testnetLoading}>Check</button>
              </div>

              {checkResult && (
                <div style={{ marginTop: '16px', marginBottom: '16px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(0,0,0,0.15)', border: '1px solid var(--border-glass)' }}>
                  <span style={{ fontSize: '13px', display: 'block', wordBreak: 'break-all' }}>
                    Wallet: <span style={{ fontFamily: 'var(--font-mono)' }}>{checkResult.address}</span>
                  </span>
                  <span style={{ fontSize: '14px', fontWeight: 'bold', display: 'block', marginTop: '6px' }} className={checkResult.eligible ? "glow-text-emerald" : "glow-text-rose"}>
                    {checkResult.eligible ? '✓ ELIGIBLE (Allowed to Hold Assets)' : '✗ NON-COMPLIANT (Blocked)'}
                  </span>
                </div>
              )}

              <div className="form-group mt-4">
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

              <div style={{ display: 'flex', gap: '12px' }} className="button-group-responsive">
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleMintTokens} disabled={testnetLoading}>
                  🪙 Mint Assets
                </button>
                <button className="btn btn-success" style={{ flex: 1 }} onClick={handleTransferTokens} disabled={testnetLoading}>
                  💸 Send Tokens
                </button>
              </div>

              <div style={{ marginTop: '20px', padding: '16px', background: 'rgba(0,0,0,0.15)', borderRadius: '8px', border: '1px solid var(--border-glass)' }}>
                <span className="form-label">Your Wallet Balance</span>
                <div className="flex-between">
                  <span style={{ fontSize: '24px', fontWeight: '800' }}>
                    {isTestnetMode ? onchainBalance : (tokenState.initialized ? vm.balanceOf(userWalletAddress) : 0)} {isTestnetMode ? 'RWA' : (tokenState.symbol || 'RWA')}
                  </span>
                  <span style={{ fontSize: '12px', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
                    {isTestnetMode ? (freighterAddress ? `${freighterAddress.substring(0, 8)}...` : 'Not Connected') : `${userWalletAddress.substring(0, 8)}...`}
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
              <div>narthex_onchain_prover_stream</div>
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

          {/* MANUAL SIGNING / XDR PANEL */}
          {isTestnetMode && (isManualWalletMode || showXdrModal) && pendingTxXdr && (
            <div className="glass-panel" style={{ padding: '20px', borderColor: 'var(--border-active)', boxShadow: 'var(--glow-violet)' }}>
              <div className="panel-header" style={{ marginBottom: '12px' }}>
                <h3 className="panel-title" style={{ fontSize: '15px' }}>✍️ Manual signing / XDR Panel</h3>
                <button 
                  className="btn btn-secondary" 
                  style={{ padding: '2px 8px', fontSize: '10px' }}
                  onClick={() => { setPendingTxXdr(''); setShowXdrModal(false); }}
                >
                  Clear
                </button>
              </div>
              <p style={{ fontSize: '11px', color: 'var(--color-text-secondary)', marginBottom: '12px', lineHeight: '1.4' }}>
                Copy the prepared transaction XDR and sign it using your wallet or the official Stellar Laboratory:
              </p>
              
              <div className="form-group">
                <label className="form-label" style={{ fontSize: '10px' }}>Prepared Tx XDR (Base64)</label>
                <textarea 
                  className="form-input form-input-mono"
                  style={{ height: '70px', fontSize: '11px', resize: 'vertical' }}
                  readOnly 
                  value={pendingTxXdr}
                  onClick={(e) => e.target.select()}
                />
              </div>

              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <a 
                  href={`https://laboratory.stellar.org/#txsigner?xdr=${encodeURIComponent(pendingTxXdr)}&network=testnet`} 
                  target="_blank" 
                  rel="noreferrer"
                  className="btn btn-primary"
                  style={{ flex: 1, fontSize: '11px', textDecoration: 'none', textAlign: 'center', padding: '10px' }}
                >
                  🚀 Sign on Stellar Laboratory
                </a>
              </div>

              <div className="form-group">
                <label className="form-label" style={{ fontSize: '10px' }}>Paste Signed Transaction XDR</label>
                <textarea 
                  className="form-input form-input-mono"
                  placeholder="AAAA..."
                  style={{ height: '70px', fontSize: '11px', resize: 'vertical' }}
                  value={signedXdrInput}
                  onChange={(e) => setSignedXdrInput(e.target.value)}
                />
              </div>

              <button 
                className="btn btn-success" 
                style={{ width: '100%', fontSize: '12px', padding: '10px' }}
                onClick={handleSubmitSignedXdr}
                disabled={testnetLoading}
              >
                📡 Submit Transaction to Testnet
              </button>
            </div>
          )}

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
                    <span className="ledger-details" style={{ fontSize: '10px', wordBreak: 'break-all' }}>{log.details}</span>
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
