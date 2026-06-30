import { Keypair, Operation, TransactionBuilder, Networks, rpc, Address, xdr, scValToNative, nativeToScVal } from 'stellar-sdk';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import pkg from 'elliptic';

const { ec: EC } = pkg;
const ec = new EC('secp256k1');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
const waitEnter = (query) => new Promise((resolve) => rl.question(query, resolve));

// Configure RPC server pointing to Stellar Testnet
const RPC_URL = 'https://soroban-testnet.stellar.org';
const server = new rpc.Server(RPC_URL);

// Load Secret Key from environment
const SECRET_KEY = process.env.STELLAR_SECRET_KEY || '';
const ADMIN_ADDRESS = 'GDT56FG5TQIOVOINF65ZHV2YQQN7KG276TKM4UGOPO3PKEMCXLDFXEUE';

async function getAccountWithRetry(publicKey, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const account = await server.getAccount(publicKey);
      return account;
    } catch (e) {
      if (attempt === maxAttempts) {
        throw e;
      }
      console.warn(`getAccount failed (attempt ${attempt}/${maxAttempts}): ${e.message}. Retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function deployWasm(sourceKeypair, wasmPath) {
  console.log(`Reading WASM bytecode from ${wasmPath}...`);
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found at ${wasmPath}. Please compile the Rust contracts first.`);
  }
  const wasm = fs.readFileSync(wasmPath);
  const localWasmHash = crypto.createHash('sha256').update(wasm).digest();

  // Always upload WASM to ensure it is active and has fresh TTL on testnet

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`Preparing transaction to upload WASM bytecode (attempt ${attempt}/5)...`);
      const account = await getAccountWithRetry(sourceKeypair.publicKey());
      const prevSeq = account.sequenceNumber();
      
      let tx = new TransactionBuilder(account, {
        fee: '5000000',
        networkPassphrase: Networks.TESTNET
      })
        .addOperation(Operation.uploadContractWasm({ wasm }))
        .setTimeout(60)
        .build();

      console.log("Simulating transaction footprint...");
      tx = await server.prepareTransaction(tx);
      
      tx.sign(sourceKeypair);
      console.log("Submitting transaction to Stellar network...");
      let response = await server.sendTransaction(tx);

      if (response.status === 'ERROR') {
        throw new Error(`Upload transaction failed: ${JSON.stringify(response.errorResult)}`);
      }

      console.log("Waiting for block consensus...");
      await pollTxStatus(response.hash);
      
      await waitForSequenceIncrement(sourceKeypair.publicKey(), prevSeq);
      console.log(`WASM successfully uploaded! Hash: ${localWasmHash.toString('hex')}\n`);
      return localWasmHash;
    } catch (e) {
      console.warn(`deployWasm attempt ${attempt}/5 failed: ${e.message}. Retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw new Error("Failed to upload WASM after 5 attempts.");
}

async function instantiateContract(sourceKeypair, wasmHash) {
  console.log(`Instantiating contract for WASM hash ${wasmHash}...`);
  
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const account = await getAccountWithRetry(sourceKeypair.publicKey());
      const prevSeq = account.sequenceNumber();
      
      let tx = new TransactionBuilder(account, {
        fee: '5000000',
        networkPassphrase: Networks.TESTNET
      })
        .addOperation(Operation.createCustomContract({
          wasmHash,
          address: new Address(sourceKeypair.publicKey())
        }))
        .setTimeout(60)
        .build();

      console.log(`Simulating transaction footprint (attempt ${attempt}/5)...`);
      tx = await server.prepareTransaction(tx);
      tx.sign(sourceKeypair);
      
      console.log("Submitting instantiation transaction...");
      let response = await server.sendTransaction(tx);
      if (response.status === 'ERROR') {
        throw new Error(`Instantiation transaction failed: ${JSON.stringify(response.errorResult)}`);
      }
      let txStatus = await pollTxStatus(response.hash);
      
      // Extract true contract ID from resultMetaXdr
      let contractId = '';
      const metaXdr = xdr.TransactionMeta.fromXDR(txStatus.resultMetaXdr, 'base64');
      const v3 = metaXdr.v3();
      const changes = v3.txChangesAfter();
      for (const change of changes) {
        let entry;
        if (change.switch() === xdr.LedgerEntryChangeType.ledgerEntryCreated()) {
          entry = change.created();
        } else if (change.switch() === xdr.LedgerEntryChangeType.ledgerEntryUpdated()) {
          entry = change.updated();
        }
        if (entry && entry.data().switch() === xdr.LedgerEntryType.contractData()) {
          const cData = entry.data().contractData();
          if (cData.key().switch() === xdr.ScValType.scvLedgerKeyContractInstance()) {
            contractId = Address.fromScAddress(cData.contract()).toString();
          }
        }
      }
      
      if (!contractId) {
        throw new Error("Failed to extract contract ID from transaction metadata.");
      }
      
      await waitForSequenceIncrement(sourceKeypair.publicKey(), prevSeq);
      console.log(`Contract successfully deployed! ID: ${contractId}\n`);
      return contractId;
    } catch (e) {
      console.warn(`instantiateContract attempt ${attempt}/5 failed: ${e.message}. Retrying in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  throw new Error("Failed to instantiate contract after 5 attempts.");
}

async function waitForSequenceIncrement(publicKey, prevSeqString) {
  const prevSeq = BigInt(prevSeqString);
  console.log(`Waiting for RPC node to sync sequence number > ${prevSeq}...`);
  for (let i = 0; i < 30; i++) {
    try {
      const account = await server.getAccount(publicKey);
      const currentSeq = BigInt(account.sequenceNumber());
      if (currentSeq > prevSeq) {
        console.log(`RPC node synced sequence number to ${currentSeq}!`);
        return account;
      }
      console.log(`Sequence not synced yet (${currentSeq} <= ${prevSeq}). Waiting 2s...`);
    } catch (e) {
      console.log(`Error checking sequence sync: ${e.message}. Waiting 2s...`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error("Timeout waiting for sequence number to increment on RPC node.");
}

async function checkWasmExists(wasmHash) {
  try {
    const key = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({
        hash: wasmHash
      })
    );
    const res = await server.getLedgerEntries(key);
    return res.entries && res.entries.length > 0;
  } catch (e) {
    console.warn("Failed to check if WASM exists, assuming false:", e.message);
    return false;
  }
}

async function pollTxStatus(hash) {
  for (let i = 0; i < 60; i++) {
    // Direct fetch to bypass buggy SDK transaction metadata parser
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: { hash }
      })
    });
    
    if (!response.ok) {
      throw new Error(`RPC server returned status ${response.status}`);
    }
    
    const body = await response.json();
    if (body.error) {
      throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
    }
    
    const txStatus = body.result;
    if (txStatus.status === 'SUCCESS') {
      return txStatus;
    }
    if (txStatus.status === 'FAILED') {
      throw new Error(`Transaction failed in ledger: ${JSON.stringify(txStatus)}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Transaction polling timed out");
}

async function checkIsInitialized(sourceKeypair, contractId) {
  try {
    const account = await getAccountWithRetry(sourceKeypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: Networks.TESTNET
    })
      .addOperation(Operation.invokeContractFunction({
        contract: contractId,
        function: 'is_initialized',
        args: []
      }))
      .setTimeout(30)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sim.error) {
      console.warn("Simulation failed (possibly not initialized):", sim.error);
      return false;
    }
    return scValToNative(sim.results[0].retval);
  } catch (e) {
    console.warn("Failed to check is_initialized, assuming false:", e.message);
    return false;
  }
}

async function run() {
  try {
    let sourceKeypair;

    if (!SECRET_KEY || SECRET_KEY.startsWith('SAXX')) {
      console.log("No STELLAR_SECRET_KEY found. Generating a new test keypair...");
      sourceKeypair = Keypair.random();
      const pubKey = sourceKeypair.publicKey();
      console.log(`New address generated: ${pubKey}`);
      console.log("Funding account via Friendbot faucet...");
      let funded = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`Friendbot funding attempt ${attempt}/3...`);
          const response = await fetch(`https://friendbot.stellar.org/?addr=${pubKey}`);
          if (response.ok) {
            funded = true;
            break;
          }
          console.warn(`Friendbot returned status ${response.status}. Retrying...`);
        } catch (e) {
          console.warn(`Friendbot fetch failed (attempt ${attempt}/3): ${e.message}. Retrying in 2s...`);
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      if (!funded) {
        console.log("\n=================================================");
        console.log(`Friendbot funding failed automatically.`);
        console.log(`Please fund this address manually on Testnet:`);
        console.log(`👉 Address: ${pubKey}`);
        console.log(`You can open: https://laboratory.stellar.org/#account-creator?addr=${pubKey}&network=testnet`);
        console.log("=================================================\n");
        await waitEnter("Once funded, press [Enter] to continue contract deployment...");
      } else {
        console.log("Account successfully funded! Waiting 30 seconds for ledger consolidation...");
        await new Promise(r => setTimeout(r, 30000));
      }
    } else {
      sourceKeypair = Keypair.fromSecret(SECRET_KEY);
    }

    console.log("Waiting for RPC server to sync the new account state...");
    let synced = false;
    for (let i = 0; i < 30; i++) {
      try {
        await server.getAccount(sourceKeypair.publicKey());
        synced = true;
        break;
      } catch (e) {
        console.log(`Account not synced on RPC node yet (attempt ${i+1}/30). Waiting 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (!synced) {
      throw new Error("RPC server failed to sync the generated account.");
    }
    console.log("Account successfully synced on RPC node!");

    console.log(`Deploying ZK-SEP-57 Contracts from address: ${sourceKeypair.publicKey()}\n`);

    // 1. Deploy ComplianceShield
    const shieldWasmPath = path.resolve('contracts/target/wasm32v1-none/release/compliance_shield.wasm');
    const shieldWasmHash = await deployWasm(sourceKeypair, shieldWasmPath);
    console.log("Waiting 6 seconds for WASM ledger entries to consolidate...");
    await new Promise(r => setTimeout(r, 6000));
    const shieldContractId = await instantiateContract(sourceKeypair, shieldWasmHash);

    // Check initialization status of ComplianceShield
    let isShieldInit = await checkIsInitialized(sourceKeypair, shieldContractId);
    console.log(`ComplianceShield initial state is_initialized(): ${isShieldInit}`);

    if (!isShieldInit) {
      console.log("Initializing ComplianceShield contract...");
      
      let shieldInitialized = false;
      for (let attempt = 1; attempt <= 10; attempt++) {
        try {
          const account = await getAccountWithRetry(sourceKeypair.publicKey());
          const prevSeq = account.sequenceNumber();
          
          const iKey = ec.genKeyPair();
          const iPubX = iKey.getPublic().getX().toArrayLike(Buffer, 'be', 32);
          const iPubY = iKey.getPublic().getY().toArrayLike(Buffer, 'be', 32);
          const issuerPubKeyBuffer = Buffer.concat([iPubX, iPubY]);
          
          let vkBuffer;
          const vkPath = path.resolve('circuits/target/verification_key.bin');
          if (fs.existsSync(vkPath)) {
            console.log("Found ZK verification key file, using it...");
            vkBuffer = fs.readFileSync(vkPath);
          } else {
            console.log("No ZK verification key file found. Using mock verification key...");
            vkBuffer = Buffer.alloc(1760, 0xff);
          }
          
          const bannedCountries = [1, 2, 3, 4, 5];
          
          const scArgs = [
            new Address(ADMIN_ADDRESS).toScVal(), // admin
            xdr.ScVal.scvBytes(issuerPubKeyBuffer), // issuer_pubkey
            xdr.ScVal.scvBytes(vkBuffer), // vk
            xdr.ScVal.scvVec(bannedCountries.map(c => xdr.ScVal.scvU32(c))) // banned_countries
          ];

          let tx = new TransactionBuilder(account, {
            fee: '5000000',
            networkPassphrase: Networks.TESTNET
          })
            .addOperation(Operation.invokeContractFunction({
              contract: shieldContractId,
              function: 'initialize',
              args: scArgs
            }))
            .setTimeout(60)
            .build();

          console.log(`Simulating initialization transaction (attempt ${attempt}/10)...`);
          tx = await server.prepareTransaction(tx);
          tx.sign(sourceKeypair);
          
          console.log("Submitting initialization transaction...");
          let response = await server.sendTransaction(tx);
          if (response.status === 'ERROR') {
            throw new Error(`Initialization transaction failed: ${JSON.stringify(response.errorResult)}`);
          }
          await pollTxStatus(response.hash);
          await waitForSequenceIncrement(sourceKeypair.publicKey(), prevSeq);
          console.log("ComplianceShield contract successfully initialized!");
          shieldInitialized = true;
          break;
        } catch (e) {
          console.warn(`ComplianceShield initialize attempt ${attempt}/10 failed: ${e.message}. Retrying in 5s...`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
      if (!shieldInitialized) {
        throw new Error("Failed to initialize ComplianceShield contract after 10 attempts.");
      }

      isShieldInit = await checkIsInitialized(sourceKeypair, shieldContractId);
      console.log(`ComplianceShield post-initialization state is_initialized(): ${isShieldInit}`);
    }

    // 2. Deploy RwaToken
    const tokenWasmPath = path.resolve('contracts/target/wasm32v1-none/release/rwa_token.wasm');
    const tokenWasmHash = await deployWasm(sourceKeypair, tokenWasmPath);
    console.log("Waiting 6 seconds for WASM ledger entries to consolidate...");
    await new Promise(r => setTimeout(r, 6000));
    const tokenContractId = await instantiateContract(sourceKeypair, tokenWasmHash);

    // Initialize RwaToken linking it to ComplianceShield
    console.log("Initializing RwaToken contract...");
    let tokenInitialized = false;
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        const tokenAccount = await getAccountWithRetry(sourceKeypair.publicKey());
        const tokenPrevSeq = tokenAccount.sequenceNumber();

        const tokenScArgs = [
          new Address(ADMIN_ADDRESS).toScVal(), // admin
          new Address(shieldContractId).toScVal(), // compliance shield registry
          nativeToScVal("Compliance Protected Realty Token"), // name
          nativeToScVal("CPRT") // symbol
        ];

        let tokenTx = new TransactionBuilder(tokenAccount, {
          fee: '5000000',
          networkPassphrase: Networks.TESTNET
        })
          .addOperation(Operation.invokeContractFunction({
            contract: tokenContractId,
            function: 'initialize',
            args: tokenScArgs
          }))
          .setTimeout(60)
          .build();

        console.log(`Simulating RwaToken initialization transaction (attempt ${attempt}/10)...`);
        tokenTx = await server.prepareTransaction(tokenTx);
        tokenTx.sign(sourceKeypair);

        console.log("Submitting RwaToken initialization transaction...");
        let tokenResponse = await server.sendTransaction(tokenTx);
        if (tokenResponse.status === 'ERROR') {
          throw new Error(`RwaToken initialization transaction failed: ${JSON.stringify(tokenResponse.errorResult)}`);
        }
        await pollTxStatus(tokenResponse.hash);
        await waitForSequenceIncrement(sourceKeypair.publicKey(), tokenPrevSeq);
        console.log("RwaToken contract successfully initialized!");
        tokenInitialized = true;
        break;
      } catch (e) {
        console.warn(`RwaToken initialize attempt ${attempt}/10 failed: ${e.message}. Retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    if (!tokenInitialized) {
      throw new Error("Failed to initialize RwaToken contract after 10 attempts.");
    }

    console.log("=================================================");
    console.log("DEPLOYMENT & INITIALIZATION SUCCESSFUL!");
    console.log(`ComplianceShield ID: ${shieldContractId}`);
    console.log(`RwaToken ID:         ${tokenContractId}`);
    console.log("=================================================");
  } catch (err) {
    console.error("Deployment failed:", err);
    console.log("\nNote: Make sure to compile your contracts into WASM first before deploying.");
    process.exit(1);
  } finally {
    rl.close();
  }
}

run();
