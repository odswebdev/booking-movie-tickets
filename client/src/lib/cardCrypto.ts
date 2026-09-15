/**
 * Card details are encrypted in the browser with the API's RSA-OAEP public key,
 * so the number, name and CVC never travel (or land in logs) in clear text.
 * Requires a secure context (https, or http://localhost) for `crypto.subtle`.
 */
export interface CardPayload {
  number: string;
  name: string;
  expiry: string;
  cvc: string;
}

export function encryptionAvailable(): boolean {
  return typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.subtle !== "undefined";
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) {
    binary += String.fromCharCode(view[index] ?? 0);
  }
  return btoa(binary);
}

export async function encryptCardPayload(payload: CardPayload, publicKeyBase64: string): Promise<string> {
  if (!encryptionAvailable()) {
    throw new Error("SECURE_CONTEXT_REQUIRED");
  }

  const key = await crypto.subtle.importKey(
    "spki",
    base64ToArrayBuffer(publicKeyBase64),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );

  const data = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, data);
  return bytesToBase64(encrypted);
}
