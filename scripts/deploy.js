import { Keypair, Operation, TransactionBuilder, Networks, rpc, Address, xdr, scValToNative } from 'stellar-sdk';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';

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

async function deployWasm(sourceKeypair, wasmPath) {
  console.log(`Reading WASM bytecode from ${wasmPath}...`);
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found at ${wasmPath}. Please compile the Rust contracts first.`);
  }
  const wasm = fs.readFileSync(wasmPath);
  const localWasmHash = crypto.createHash('sha256').update(wasm).digest();

  // Check if WASM already exists on-chain
  const exists = await checkWasmExists(localWasmHash);
  if (exists) {
    console.log(`WASM already exists on-chain! Skipping upload. Hash: ${localWasmHash.toString('hex')}\n`);
    return localWasmHash;
  }

  console.log("Preparing transaction to upload WASM bytecode...");
  const account = await server.getAccount(sourceKeypair.publicKey());
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
}

async function instantiateContract(sourceKeypair, wasmHash) {
  console.log(`Instantiating contract for WASM hash ${wasmHash}...`);
  const account = await server.getAccount(sourceKeypair.publicKey());
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

  console.log("Simulating transaction footprint...");
  let preparedTx = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      preparedTx = await server.prepareTransaction(tx);
      break;
    } catch (e) {
      const errMsg = e.message || '';
      if (errMsg.includes('MissingValue') || errMsg.includes('Wasm does not exist') || errMsg.includes('HostError')) {
        console.warn(`Simulation failed: WASM not indexed yet (attempt ${attempt}/10). Retrying in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw e;
      }
    }
  }
  if (!preparedTx) {
    throw new Error("Transaction simulation timed out waiting for WASM indexing.");
  }
  tx = preparedTx;
  tx.sign(sourceKeypair);
  
  let response = await server.sendTransaction(tx);
  if (response.status === 'ERROR') {
    throw new Error(`Instantiation transaction failed: ${JSON.stringify(response.errorResult)}`);
  }
  let txStatus = await pollTxStatus(response.hash);
  
  // Parse resultXdr manually to extract the Contract ID
  const txResult = xdr.TransactionResult.fromXDR(txStatus.resultXdr, 'base64');
  const opResult = txResult.result().results()[0];
  const contractIdBuffer = opResult.tr().invokeHostFunctionResult().success();
  const contractId = Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractIdBuffer)).toString();
  
  await waitForSequenceIncrement(sourceKeypair.publicKey(), prevSeq);
  console.log(`Contract successfully deployed! ID: ${contractId}\n`);
  return contractId;
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
        console.log("Account successfully funded! Waiting 10 seconds for ledger consolidation...");
        await new Promise(r => setTimeout(r, 10000));
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

    // 2. Deploy RwaToken
    const tokenWasmPath = path.resolve('contracts/target/wasm32v1-none/release/rwa_token.wasm');
    const tokenWasmHash = await deployWasm(sourceKeypair, tokenWasmPath);
    console.log("Waiting 6 seconds for WASM ledger entries to consolidate...");
    await new Promise(r => setTimeout(r, 6000));
    const tokenContractId = await instantiateContract(sourceKeypair, tokenWasmHash);

    console.log("=================================================");
    console.log("DEPLOYMENT SUCCESSFUL!");
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
