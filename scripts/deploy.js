import { Keypair, Asset, Operation, TransactionBuilder, Networks, rpc, Address, xdr } from 'stellar-sdk';
import fs from 'fs';
import path from 'path';

// Configure RPC server pointing to Stellar Testnet
const RPC_URL = 'https://soroban-testnet.stellar.org';
const server = new rpc.Server(RPC_URL);

// Load Secret Key from environment or argument
const SECRET_KEY = process.env.STELLAR_SECRET_KEY || 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

async function deployWasm(sourceKeypair, wasmPath) {
  console.log(`Reading WASM byte code from ${wasmPath}...`);
  if (!fs.existsSync(wasmPath)) {
    throw new Error(`WASM file not found at ${wasmPath}. Run cargo build --target wasm32-unknown-unknown --release first.`);
  }
  const wasm = fs.readFileSync(wasmPath);

  console.log("Preparing transaction to upload WASM bytecode...");
  const account = await server.getAccount(sourceKeypair.publicKey());
  
  let tx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .setTimeout(30)
    .build();

  // Simulate transaction to compute resource footprint and Soroban fees
  console.log("Simulating transaction footprint...");
  tx = await server.prepareTransaction(tx);
  
  tx.sign(sourceKeypair);
  console.log("Submitting transaction to Stellar network...");
  let response = await server.sendTransaction(tx);

  if (response.status === 'ERROR') {
    throw new Error(`Upload transaction failed: ${JSON.stringify(response.errorResult)}`);
  }

  // Poll for status
  console.log("Waiting for block consensus...");
  let txResult = await pollTxStatus(response.hash);
  
  // Extract WASM hash from transaction result
  const wasmHash = txResult.wasmId;
  console.log(`WASM successfully uploaded! Hash: ${wasmHash}\n`);
  return wasmHash;
}

async function instantiateContract(sourceKeypair, wasmHash) {
  console.log(`Instantiating contract for WASM hash ${wasmHash}...`);
  const account = await server.getAccount(sourceKeypair.publicKey());
  
  let tx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(Operation.createContract({
      wasmHash,
      address: new Address(sourceKeypair.publicKey())
    }))
    .setTimeout(30)
    .build();

  tx = await server.prepareTransaction(tx);
  tx.sign(sourceKeypair);
  
  let response = await server.sendTransaction(tx);
  let txResult = await pollTxStatus(response.hash);
  
  const contractId = txResult.contractId;
  console.log(`Contract successfully deployed! ID: ${contractId}\n`);
  return contractId;
}

async function pollTxStatus(hash) {
  for (let i = 0; i < 15; i++) {
    const status = await server.getTransaction(hash);
    if (status.status === 'SUCCESS') {
      return status;
    }
    if (status.status === 'FAILED') {
      throw new Error(`Transaction failed in ledger: ${JSON.stringify(status)}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error("Transaction polling timed out");
}

async function run() {
  if (SECRET_KEY === 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX') {
    console.error("Error: Please set your STELLAR_SECRET_KEY environment variable to deploy to Testnet.");
    process.exit(1);
  }

  const sourceKeypair = Keypair.fromSecret(SECRET_KEY);
  console.log(`Deploying ZK-SEP-57 Contracts from address: ${sourceKeypair.publicKey()}\n`);

  try {
    // 1. Deploy ComplianceShield
    const shieldWasmPath = path.resolve('contracts/target/wasm32-unknown-unknown/release/compliance_shield.wasm');
    const shieldWasmHash = await deployWasm(sourceKeypair, shieldWasmPath);
    const shieldContractId = await instantiateContract(sourceKeypair, shieldWasmHash);

    // 2. Deploy RwaToken
    const tokenWasmPath = path.resolve('contracts/target/wasm32-unknown-unknown/release/rwa_token.wasm');
    const tokenWasmHash = await deployWasm(sourceKeypair, tokenWasmPath);
    const tokenContractId = await instantiateContract(sourceKeypair, tokenWasmHash);

    console.log("=================================================");
    console.log("DEPLOYMENT SUCCESSFUL!");
    console.log(`ComplianceShield ID: ${shieldContractId}`);
    console.log(`RwaToken ID:         ${tokenContractId}`);
    console.log("=================================================");
  } catch (err) {
    console.error("Deployment failed:", err);
    process.exit(1);
  }
}

run();
