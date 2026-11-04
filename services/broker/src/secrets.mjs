import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for `broker_secrets` (contract section 6).
 * - random 12-byte IV per write
 * - the connection id is the additional authenticated data, so a row copied onto another
 *   connection does not decrypt
 * - base64 fields, `key_version` picks the key (old keys stay readable during a rotation)
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** @typedef {{ key_version: number, iv: string, tag: string, ciphertext: string }} SealedSecret */

export class SecretError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SecretError";
  }
}

/**
 * @param {{ key: Buffer, keyVersion: number, previousKeys?: Map<number, Buffer> }} opts
 */
export function createSecretBox({ key, keyVersion, previousKeys = new Map() }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new SecretError("the token key must be 32 bytes");
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new SecretError("the key version must be a positive integer");
  /** @type {Map<number, Buffer>} */
  const keys = new Map(previousKeys);
  keys.set(keyVersion, key);
  for (const k of keys.values()) {
    if (!Buffer.isBuffer(k) || k.length !== 32) throw new SecretError("every token key must be 32 bytes");
  }

  /** @param {string} connectionId */
  const aad = (connectionId) => {
    if (typeof connectionId !== "string" || connectionId.length === 0) throw new SecretError("a connection id is required");
    return Buffer.from(connectionId, "utf8");
  };

  return {
    keyVersion,

    /**
     * @param {string} connectionId
     * @param {unknown} value JSON-serialisable
     * @returns {SealedSecret}
     */
    encrypt(connectionId, value) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad(connectionId));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return {
        key_version: keyVersion,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },

    /**
     * @param {string} connectionId
     * @param {{ key_version?: number, iv: string, tag: string, ciphertext: string }} row
     * @returns {any}
     */
    decrypt(connectionId, row) {
      const version = row.key_version ?? 1;
      const k = keys.get(version);
      if (!k) throw new SecretError(`no key for key_version ${version}`);
      const iv = Buffer.from(row.iv ?? "", "base64");
      const tag = Buffer.from(row.tag ?? "", "base64");
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretError("the stored secret is malformed");
      try {
        const decipher = createDecipheriv("aes-256-gcm", k, iv, { authTagLength: TAG_BYTES });
        decipher.setAAD(aad(connectionId));
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(Buffer.from(row.ciphertext ?? "", "base64")), decipher.final()]);
        return JSON.parse(plain.toString("utf8"));
      } catch {
        // Never say more: which part failed is not useful to anyone but an attacker.
        throw new SecretError("the stored secret could not be decrypted");
      }
    },

    /** True when the row was sealed with an older key and should be re-encrypted. */
    /** @param {{ key_version?: number }} row */
    needsRotation(row) {
      return (row.key_version ?? 1) !== keyVersion;
    },
  };
}

/** @typedef {ReturnType<typeof createSecretBox>} SecretBox */
