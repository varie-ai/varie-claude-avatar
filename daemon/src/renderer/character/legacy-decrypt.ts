/**
 * Legacy Bundle Decryption (INTERNAL USE ONLY)
 *
 * This module handles decryption of legacy encrypted .varie bundles
 * for testing purposes during development.
 *
 * DO NOT EXPOSE THIS MODULE OR ITS KEY EXTERNALLY.
 * Production bundles should use plain (unencrypted) format.
 */

const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const MAGIC = 'VARI';

/**
 * Decrypt a legacy encrypted bundle
 * @internal
 */
export async function decryptLegacyBundle(encryptedData: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(encryptedData);

  if (bytes.length < IV_SIZE + AUTH_TAG_SIZE) {
    throw new Error('Encrypted data too short');
  }

  // Parse format: [IV][AuthTag][Ciphertext]
  const iv = bytes.slice(0, IV_SIZE);
  const authTag = bytes.slice(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
  const ciphertext = bytes.slice(IV_SIZE + AUTH_TAG_SIZE);

  // Web Crypto expects ciphertext with tag appended
  const ciphertextWithTag = new Uint8Array(ciphertext.length + authTag.length);
  ciphertextWithTag.set(ciphertext);
  ciphertextWithTag.set(authTag, ciphertext.length);

  // Get key (assembled internally)
  const key = await getDecryptionKey();

  // Decrypt
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: AUTH_TAG_SIZE * 8 },
    key,
    ciphertextWithTag
  );
}

/**
 * Check if data needs decryption (doesn't have VARI magic header)
 */
export function needsDecryption(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return true;
  const magic = String.fromCharCode(...new Uint8Array(data.slice(0, 4)));
  return magic !== MAGIC;
}

/**
 * Unpack a decrypted bundle
 */
export function unpackBundle(data: ArrayBuffer): Map<string, ArrayBuffer> {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  let offset = 0;

  // Verify magic
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  if (magic !== MAGIC) {
    throw new Error(`Invalid bundle format: ${magic}`);
  }
  offset += 4;

  // Skip version
  offset += 4;

  // Read file count
  const fileCount = view.getUint32(offset, true);
  offset += 4;

  const files = new Map<string, ArrayBuffer>();

  for (let i = 0; i < fileCount; i++) {
    const pathLength = view.getUint32(offset, true);
    offset += 4;

    const pathBytes = bytes.slice(offset, offset + pathLength);
    const path = new TextDecoder().decode(pathBytes);
    offset += pathLength;

    const dataLength = view.getUint32(offset, true);
    offset += 4;

    const fileData = data.slice(offset, offset + dataLength);
    offset += dataLength;

    files.set(path, fileData);
  }

  return files;
}

// Key assembly (obfuscated for minimal exposure)
let cachedKey: CryptoKey | null = null;

async function getDecryptionKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;

  // Key parts (same as extension, assembled at runtime)
  const p = [
    [0x76, 0x61, 0x72, 0x69], // 1
    [0x65, 0x4d, 0x61, 0x74], // 2
    [0x65, 0x4c, 0x69, 0x76], // 3
    [0x65, 0x32, 0x44, 0x53], // 4
    [0x44, 0x4b, 0x45, 0x6e], // 5
    [0x63, 0x72, 0x79, 0x70], // 6
    [0x74, 0x65, 0x64, 0x41], // 7
    [0x45, 0x53, 0x32, 0x35], // 8
  ];

  const keyBytes = new Uint8Array(32);
  let offset = 0;
  for (const part of p) {
    for (const b of part) {
      keyBytes[offset++] = b;
    }
  }

  cachedKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  return cachedKey;
}
