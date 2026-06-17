# Hackathon Video Demo Walkthrough Script

This document contains a structured timeline and presenter script for recording the mandatory **2-3 minute walkthrough video** for the Stellar Hacks submission. 

---

## 📹 Video Timeline & Structure

* **0:00 - 0:45 | Intro & The Problem** (Value proposition, regulations vs. privacy)
* **0:45 - 1:15 | Issuer Portal** (Mock credential generation)
* **1:15 - 2:00 | User Portal & ZK-Prover** (WASM proof generation, nullifiers, registration)
* **2:00 - 2:45 | Regulated Transfers & dynamic checking** (Compliance enforcement ledger)
* **2:45 - 3:00 | Outro & Summary** (Stellar Protocol 26 BN254 host benefits)

---

## 🎙️ Presenter Script

### Scene 1: Introduction & Problem (0:00 - 0:45)
* **Visual**: Show the live landing page at [https://narthex-eta.vercel.app/](https://narthex-eta.vercel.app/). Hover the mouse over the header.
* **Talking Points**:
  > *"Hi everyone, I’m excited to show you **Narthex**, a ZK-SEP-57 Compliance Shield on the Stellar Soroban smart contract platform. In the real world, moving money on-chain requires compliance checks like KYC/AML. But storing user passports, country codes, or accreditation parameters on-chain represents a massive privacy risk.*
  >
  > *Narthex solves this. It lets users prove they hold a valid KYC credential signed by an approved issuer and do not reside in a banned country, using client-side Zero-Knowledge proofs. The proof is verified on-chain to register the wallet, keeping the private details off the ledger."*

### Scene 2: The Issuer Portal (0:45 - 1:15)
* **Visual**: Click on the **Issuer Portal** tab. Show the input fields (Country Code: 840, Accredited: True). Click **Sign & Issue KYC Credential**. Point to the raw signature output.
* **Talking Points**:
  > *"Here, in the Issuer Portal, a KYC authority signs a user’s public key alongside their country code and accreditation status. This signature represents a verifiable credential. It is passed to the client-side prover, serving as a private witness. Note that the issuer’s public key is stored on-chain in the Compliance Shield contract to check credentials."*

### Scene 3: Client-Side ZK Prover (1:15 - 2:00)
* **Visual**: Click on the **User ZK Prover** tab. Click **Generate ZK Proof**. Show the logs filling up the black terminal window ( witness compilation, ACIR constraints load, UltraHonk proof synthesis). Once finished, click **Register Wallet**.
* **Talking Points**:
  > *"Next, the user selects their target Stellar address. The browser loads the compiled Noir circuit, compiles the private witness inputs, and generates an UltraHonk proof. The circuit checks that: 1. the user controls the wallet, 2. the credential is validly signed, and 3. the country code is not in the banned country list.*
  >
  > *When we click Register Wallet, we submit the proof and a unique nullifier to the ComplianceShield contract. The contract verifies the proof using Stellar's Protocol 26 BN254 host functions. Registration is instant, and the user's country code is never revealed on-chain."*

### Scene 4: Compliance Enforcement (2:00 - 2:45)
* **Visual**: Click on the **Asset Ledger (RWA)** tab. Show that the registered user wallet now has balance. Enter a random unregistered wallet address in the input, enter an amount, and click **Send Tokens**. Show the failed log output.
* **Talking Points**:
  > *"To see how compliance is enforced, we navigate to our RWA Token ledger. Our token contract dynamically queries the ComplianceShield contract before completing any mint or transfer action. If we attempt to transfer tokens to an unregistered address, the transaction immediately panics and aborts, securing compliance."*

### Scene 5: Outro & Summary (2:45 - 3:00)
* **Visual**: Scroll down the dashboard to show the transaction history logs. Hover over the success/failed badges.
* **Talking Points**:
  > *"By utilizing Noir, Soroban, and Stellar's native BN254 host primitives, Narthex brings high-speed, affordable compliance privacy to real-world assets. Thanks for watching!"*
