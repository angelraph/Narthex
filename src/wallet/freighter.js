import {
  isConnected,
  requestAccess,
  getAddress,
  signTransaction
} from "@stellar/freighter-api";

/**
 * Checks if the Freighter wallet extension is installed.
 * @returns {Promise<boolean>}
 */
export const isWalletInstalled = async () => {
  try {
    const connected = await isConnected();
    return !!connected;
  } catch (e) {
    return false;
  }
};

/**
 * Requests access and connects to the Freighter wallet.
 * @returns {Promise<string>} The active wallet address.
 */
export const connectWallet = async () => {
  const installed = await isWalletInstalled();
  if (!installed) {
    throw new Error("Freighter extension not detected.");
  }

  // Request wallet access (prompts user authorization dialog)
  try {
    await requestAccess();
  } catch (e) {
    throw new Error(`User rejected access request: ${e.message || e}`);
  }

  // Retrieve authorized public address
  const addressInfo = await getAddress();
  if (!addressInfo || !addressInfo.address) {
    throw new Error("Could not retrieve wallet address. Please ensure Freighter is unlocked.");
  }

  return addressInfo.address;
};

/**
 * Gets the current active address from Freighter.
 * @returns {Promise<string>} The active wallet address.
 */
export const getWalletAddress = async () => {
  const addressInfo = await getAddress();
  if (!addressInfo || !addressInfo.address) {
    throw new Error("Could not retrieve wallet address. Please unlock your Freighter wallet.");
  }
  return addressInfo.address;
};

/**
 * Signs a transaction XDR with the Freighter wallet.
 * @param {string} xdr The transaction base64 XDR.
 * @param {string} networkPassphrase The passphrase of the target Stellar network.
 * @returns {Promise<string>} The signed transaction XDR.
 */
export const signXdr = async (xdr, networkPassphrase) => {
  try {
    const signed = await signTransaction(xdr, {
      network: "TESTNET",
      networkPassphrase
    });
    return signed;
  } catch (e) {
    throw new Error(`Signing cancelled or failed: ${e.message || e}`);
  }
};
