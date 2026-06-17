// 1. Monkey-patch path module to prevent Windows path parsing issues in Noir/WASM backend
import path from 'path';

const originalJoin = path.join;
path.join = function (...args) {
  return originalJoin(...args).replace(/\\/g, '/');
};

const originalResolve = path.resolve;
path.resolve = function (...args) {
  return originalResolve(...args).replace(/\\/g, '/');
};

const originalRelative = path.relative;
path.relative = function (from, to) {
  return originalRelative(from, to).replace(/\\/g, '/');
};

// 2. Import other dependencies
import fs from 'fs';
import crypto from 'crypto';
import blake from 'blakejs';
import pkg from 'elliptic';
const { ec: EC } = pkg;
const ec = new EC('secp256k1');

import { Address, Keypair } from 'stellar-sdk';
import { Noir } from '@noir-lang/noir_js';
import { Barretenberg, UltraHonkBackend } from '@aztec/bb.js';

async function run() {
  console.log("Starting ZK proof generation script...");

  // A. Load Compiled Circuit
  const circuitPath = path.resolve('circuits/target/compliance_shield.json');
  if (!fs.existsSync(circuitPath)) {
    console.error(`Error: Circuit file not found at ${circuitPath}. Run compile first.`);
    process.exit(1);
  }
  const circuit = JSON.parse(fs.readFileSync(circuitPath, 'utf8'));

  // B. Generate Mock Cryptographic Keys (secp256k1) using elliptic
  console.log("Generating mock secp256k1 keys for User and KYC Issuer...");
  const userKeyPair = ec.genKeyPair();
  const issuerKeyPair = ec.genKeyPair();

  const userPubPoint = userKeyPair.getPublic();
  const userPubkeyX = userPubPoint.getX().toArrayLike(Buffer, 'be', 32);
  const userPubkeyY = userPubPoint.getY().toArrayLike(Buffer, 'be', 32);

  const issuerPubPoint = issuerKeyPair.getPublic();
  const issuerPubkeyX = issuerPubPoint.getX().toArrayLike(Buffer, 'be', 32);
  const issuerPubkeyY = issuerPubPoint.getY().toArrayLike(Buffer, 'be', 32);

  // C. Setup Mock KYC Credential details (non-banned country)
  const countryCode = 840; // United States
  const isAccredited = true;
  const secretSaltBytes = crypto.randomBytes(32);
  secretSaltBytes[0] &= 0x1f; // Ensure fits in field modulus
  const secretSaltHex = '0x' + secretSaltBytes.toString('hex');
  const bannedCountries = [1, 2, 3, 4, 5]; // US (840) is not banned

  // D. Mock target wallet to register
  const targetWalletKeypair = Keypair.random();
  const targetWalletAddress = targetWalletKeypair.publicKey();
  console.log(`Target wallet address: ${targetWalletAddress}`);

  // Serialize target wallet address using Stellar SDK to match SCAddress XDR
  const addr = new Address(targetWalletAddress);
  const scAddress = addr.toScAddress();
  const xdrBytes = scAddress.toXDR();
  console.log(`XDR Serialized wallet length: ${xdrBytes.length} bytes`);

  // Hash using Blake2s (256-bit) and mask the top 3 bits to fit within BN254 field modulus
  const walletHashBytes = blake.blake2s(xdrBytes, null, 32);
  walletHashBytes[0] &= 0x1f;
  const walletHashHex = '0x' + Buffer.from(walletHashBytes).toString('hex');
  console.log(`Masked Wallet Blake2s hash: ${walletHashHex}`);

  // E. User signs the wallet hash directly to prove key ownership
  console.log("User signing the wallet hash...");
  const userSig = userKeyPair.sign(walletHashBytes, { canonical: true });
  const userRawSig = Buffer.concat([
    userSig.r.toArrayLike(Buffer, 'be', 32),
    userSig.s.toArrayLike(Buffer, 'be', 32)
  ]);

  // F. Issuer signs the serialized KYC Credential
  console.log("KYC Anchor/Issuer signing the KYC credential...");
  const credBytes = Buffer.alloc(101);
  userPubkeyX.copy(credBytes, 0);
  userPubkeyY.copy(credBytes, 32);
  credBytes.writeUInt32BE(countryCode, 64);
  credBytes.writeUInt8(isAccredited ? 1 : 0, 68);
  const saltBuffer = Buffer.from(secretSaltHex.replace('0x', '').padStart(64, '0'), 'hex');
  saltBuffer.copy(credBytes, 69);

  const credHash = blake.blake2s(credBytes, null, 32);
  const issuerSig = issuerKeyPair.sign(credHash, { canonical: true });
  const issuerRawSig = Buffer.concat([
    issuerSig.r.toArrayLike(Buffer, 'be', 32),
    issuerSig.s.toArrayLike(Buffer, 'be', 32)
  ]);

  // G. Compile Inputs
  const inputs = {
    user_pubkey_x: Array.from(userPubkeyX),
    user_pubkey_y: Array.from(userPubkeyY),
    user_signature: Array.from(userRawSig),
    issuer_signature: Array.from(issuerRawSig),
    issuer_pub_key_x: Array.from(issuerPubkeyX),
    issuer_pub_key_y: Array.from(issuerPubkeyY),
    country_code: countryCode,
    is_accredited: isAccredited,
    secret_salt: secretSaltHex,
    
    target_wallet_hash: walletHashHex,
    banned_countries: bannedCountries
  };

  // H. Execute Circuit & Generate Proof
  console.log("Instantiating Barretenberg and UltraHonkBackend...");
  const api = await Barretenberg.new();
  const backend = new UltraHonkBackend(circuit.program.bytecode, api);
  const noir = new Noir(circuit.program);

  console.log("Executing circuit logic to generate witness and compute nullifier...");
  const { witness, returnValue } = await noir.execute(inputs);
  const nullifierHex = returnValue.toString();
  console.log(`Computed Nullifier: ${nullifierHex}`);

  console.log("Generating zero-knowledge proof (UltraHonk)...");
  const proofData = await backend.generateProof(witness);
  console.log("Successfully generated ZK proof!");
  console.log(`Proof length: ${proofData.proof.length} bytes`);

  // I. Extract Verification Key (VK)
  const vkBytes = await backend.getVerificationKey();
  console.log(`Verification Key length: ${vkBytes.length} bytes`);

  // J. Serialize Public Inputs in 32-byte big-endian fields to match contract layout
  const nullifierBytes = Buffer.from(nullifierHex.replace('0x', '').padStart(64, '0'), 'hex');
  const pubInputsBuffer = Buffer.alloc(224); // 7 fields * 32 bytes = 224 bytes
  
  nullifierBytes.copy(pubInputsBuffer, 0);
  Buffer.from(walletHashHex.replace('0x', '').padStart(64, '0'), 'hex').copy(pubInputsBuffer, 32);
  
  for (let i = 0; i < 5; i++) {
    const country = bannedCountries[i];
    const countryBytes = Buffer.alloc(32);
    countryBytes.writeUInt32BE(country, 28);
    countryBytes.copy(pubInputsBuffer, 64 + i * 32);
  }

  // K. Write Output Files
  const targetDir = path.resolve('circuits/target');
  
  fs.writeFileSync(path.join(targetDir, 'proof.bin'), proofData.proof);
  fs.writeFileSync(path.join(targetDir, 'verification_key.bin'), vkBytes);
  fs.writeFileSync(path.join(targetDir, 'public_inputs.bin'), pubInputsBuffer);

  const proofSummary = {
    nullifier: nullifierHex,
    wallet_hash: walletHashHex,
    target_wallet: targetWalletAddress,
    banned_countries: bannedCountries,
    proof_hex: '0x' + Buffer.from(proofData.proof).toString('hex'),
    vk_hex: '0x' + Buffer.from(vkBytes).toString('hex'),
    public_inputs_hex: '0x' + pubInputsBuffer.toString('hex'),
    issuer_pub_key_hex: '0x' + Buffer.concat([issuerPubkeyX, issuerPubkeyY]).toString('hex')
  };

  fs.writeFileSync(
    path.join(targetDir, 'proof_summary.json'),
    JSON.stringify(proofSummary, null, 2)
  );

  console.log("\n--- Proof Generation Success Summary ---");
  console.log(`Saved proof.bin -> ${path.join(targetDir, 'proof.bin')}`);
  console.log(`Saved verification_key.bin -> ${path.join(targetDir, 'verification_key.bin')}`);
  console.log(`Saved public_inputs.bin -> ${path.join(targetDir, 'public_inputs.bin')}`);
  console.log(`Saved proof_summary.json -> ${path.join(targetDir, 'proof_summary.json')}`);
  console.log("----------------------------------------\n");

  await api.destroy();
}

run().catch(err => {
  console.error("Prover script failed with error:", err);
  process.exit(1);
});
