import { generateKeyPairSync, privateDecrypt, publicEncrypt, constants } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { PaymentPublicKey } from "../../../shared/types.js";

/**
 * Card details never travel in plain JSON: the browser encrypts them with this
 * RSA-OAEP public key and the server decrypts them in memory. No card number is
 * ever written to disk or to the logs.
 *
 * In production you would terminate this behind TLS (mandatory) and, for PCI
 * compliance, hand the decrypted payload straight to the PSP without storing it.
 */
export interface PaymentKeyPair {
  keyId: string;
  publicKey: PaymentPublicKey;
  decrypt(encryptedBase64: string): string;
}

const KEY_ID = randomUUID();

let current: PaymentKeyPair | null = null;

export function getPaymentKeyPair(): PaymentKeyPair {
  if (current) return current;

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const publicKeyDer = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");

  current = {
    keyId: KEY_ID,
    publicKey: {
      keyId: KEY_ID,
      publicKey: publicKeyDer,
      algorithm: "RSA-OAEP-256",
    },
    decrypt(encryptedBase64: string): string {
      const buffer = Buffer.from(encryptedBase64, "base64");
      if (buffer.length === 0 || buffer.length > 512) {
        throw new Error("Invalid encrypted payload");
      }
      return privateDecrypt(
        {
          key: privateKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: "sha256",
        },
        buffer,
      ).toString("utf8");
    },
  };

  return current;
}

/** Test helper: encrypts with the public key the same way the browser does. */
export function encryptLikeBrowser(plaintext: string, publicKey: PaymentPublicKey): string {
  const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey.publicKey.match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----`;
  return publicEncrypt(
    {
      key: pem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(plaintext, "utf8"),
  ).toString("base64");
}
