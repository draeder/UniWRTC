import { encryptMessageWithMeta, decryptMessageWithMeta } from 'unsea';

/**
 * Encryption utilities for signaling messages using unsea (ECIES)
 * Uses elliptic curve cryptography for secure peer-to-peer encryption
 */

// Store peer public keys by peer ID (hex)
const peerPublicKeys = new Map();

/**
 * Register a peer's public key (hex string)
 * @param {string} peerId - Peer ID (hex)
 * @param {object} publicKeyObj - Public key object from unsea
 */
export function registerPeerPublicKey(peerId, publicKeyObj) {
  peerPublicKeys.set(peerId, publicKeyObj);
}

/**
 * Get a peer's public key
 * @param {string} peerId - Peer ID (hex)
 * @returns {object|null} Public key object or null
 */
export function getPeerPublicKey(peerId) {
  return peerPublicKeys.get(peerId) || null;
}

/**
 * Encrypt a JSON payload for transmission to a specific peer
 * @param {object} payload - Object to encrypt
 * @param {object} recipientPublicKey - Recipient's public key object from unsea
 * @returns {Promise<object>} Encrypted message with metadata
 */
export async function encryptPayload(payload, recipientPublicKey) {
  try {
    const plaintext = JSON.stringify(payload);
    const encrypted = await encryptMessageWithMeta(plaintext, recipientPublicKey);
    return encrypted;
  } catch (e) {
    console.error('[Crypto] Encryption failed:', e);
    throw e;
  }
}

/**
 * Decrypt a payload using unsea
 * @param {object} encrypted - Encrypted message object
 * @param {object} senderPublicKey - Sender's public key object
 * @param {object} myPrivateKey - This peer's private key object
 * @returns {Promise<object>} Decrypted JSON payload
 */
export async function decryptPayload(encrypted, senderPublicKey, myPrivateKey) {
  try {
    const plaintext = await decryptMessageWithMeta(encrypted, senderPublicKey, myPrivateKey);
    return JSON.parse(plaintext);
  } catch (e) {
    console.error('[Crypto] Decryption failed:', e);
    throw e;
  }
}

/**
 * Wrap a payload for encrypted transmission
 * @param {object} payload - Payload to wrap
 * @param {object} recipientPublicKey - Recipient's public key object from unsea
 * @returns {Promise<object>} Wrapped envelope with encrypted content
 */
export async function wrapEncryptedPayload(payload, recipientPublicKey) {
  const encrypted = await encryptPayload(payload, recipientPublicKey);
  return {
    type: 'encrypted',
    encrypted: true,
    content: JSON.stringify(encrypted),
  };
}

/**
 * Unwrap an encrypted payload
 * @param {object} envelope - Encrypted envelope
 * @param {object} senderPublicKey - Sender's public key object
 * @param {object} myPrivateKey - This peer's private key object
 * @returns {Promise<object>} Decrypted payload
 */
export async function unwrapEncryptedPayload(envelope, senderPublicKey, myPrivateKey) {
  if (!envelope.encrypted) {
    throw new Error('Payload is not encrypted');
  }
  const encrypted = JSON.parse(envelope.content);
  return decryptPayload(encrypted, senderPublicKey, myPrivateKey);
}

// Dummy function for compatibility
export function deriveSharedSecret(pubkey1, pubkey2) {
  return { pubkey1, pubkey2 };
}
