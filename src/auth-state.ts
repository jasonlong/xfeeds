import type { BrowserContextOptions } from "@cloudflare/playwright";

export const AUTH_STATE_KV_KEY = "x-auth-state:v1";
export const MAX_AUTH_STATE_BYTES = 64 * 1024;

const encryptionVersion = 1 as const;
const encryptionAdditionalData = new TextEncoder().encode("xfeeds-auth-state:v1");
const allowedHosts = new Set(["x.com", "twitter.com"]);
const sameSiteValues = new Set(["Strict", "Lax", "None"]);

export type StorageState = Exclude<
  BrowserContextOptions["storageState"],
  string | undefined
>;

export interface EncryptedAuthState {
  version: typeof encryptionVersion;
  iv: string;
  ciphertext: string;
  updatedAt: string;
}

export interface AuthStateMetadata {
  cookieCount: number;
  domains: string[];
  updatedAt: string;
}

export class AuthStateError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AuthStateError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedCookieHost(domain: string): string {
  return domain.toLowerCase().replace(/^\./, "");
}

function isAllowedCookieDomain(domain: string): boolean {
  return allowedHosts.has(normalizedCookieHost(domain));
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "https:" &&
      url.origin === origin &&
      allowedHosts.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    throw new AuthStateError("auth-state-not-json");
  }
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new AuthStateError("auth-state-unexpected-field");
  }
}

function validateCookie(cookie: unknown): asserts cookie is StorageState["cookies"][number] {
  if (!isRecord(cookie)) throw new AuthStateError("auth-state-invalid-cookie");
  requireExactKeys(cookie, [
    "name",
    "value",
    "domain",
    "path",
    "expires",
    "httpOnly",
    "secure",
    "sameSite",
  ]);
  if (
    typeof cookie.name !== "string" ||
    typeof cookie.value !== "string" ||
    typeof cookie.domain !== "string" ||
    !isAllowedCookieDomain(cookie.domain) ||
    typeof cookie.path !== "string" ||
    !cookie.path.startsWith("/") ||
    typeof cookie.expires !== "number" ||
    !Number.isFinite(cookie.expires) ||
    typeof cookie.httpOnly !== "boolean" ||
    typeof cookie.secure !== "boolean" ||
    typeof cookie.sameSite !== "string" ||
    !sameSiteValues.has(cookie.sameSite)
  ) {
    throw new AuthStateError("auth-state-invalid-cookie");
  }
}

function validateOrigin(origin: unknown): asserts origin is StorageState["origins"][number] {
  if (!isRecord(origin)) throw new AuthStateError("auth-state-invalid-origin");
  requireExactKeys(origin, ["origin", "localStorage"]);
  if (
    typeof origin.origin !== "string" ||
    !isAllowedOrigin(origin.origin) ||
    !Array.isArray(origin.localStorage)
  ) {
    throw new AuthStateError("auth-state-invalid-origin");
  }
  for (const entry of origin.localStorage) {
    if (!isRecord(entry)) throw new AuthStateError("auth-state-invalid-local-storage");
    requireExactKeys(entry, ["name", "value"]);
    if (typeof entry.name !== "string" || typeof entry.value !== "string") {
      throw new AuthStateError("auth-state-invalid-local-storage");
    }
  }
}

export function validateStorageState(value: unknown): StorageState {
  if (jsonByteLength(value) > MAX_AUTH_STATE_BYTES) {
    throw new AuthStateError("auth-state-too-large");
  }
  if (!isRecord(value)) throw new AuthStateError("auth-state-invalid");
  requireExactKeys(value, ["cookies", "origins"]);
  if (!Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
    throw new AuthStateError("auth-state-invalid");
  }

  const cookies: StorageState["cookies"] = [];
  const origins: StorageState["origins"] = [];
  for (const cookie of value.cookies) {
    validateCookie(cookie);
    cookies.push(cookie);
  }
  for (const origin of value.origins) {
    validateOrigin(origin);
    origins.push(origin);
  }

  const hasAuthToken = cookies.some((cookie) =>
    cookie.name === "auth_token" && cookie.value.length > 0
  );
  if (!hasAuthToken) throw new AuthStateError("auth-state-missing-auth-token");
  return { cookies, origins };
}

export function filterStorageState(value: StorageState): StorageState {
  return validateStorageState({
    cookies: value.cookies
      .filter((cookie) => isAllowedCookieDomain(cookie.domain))
      .map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      })),
    origins: value.origins
      .filter((origin) => isAllowedOrigin(origin.origin))
      .map((origin) => ({
        origin: origin.origin,
        localStorage: origin.localStorage.map((entry) => ({
          name: entry.name,
          value: entry.value,
        })),
      })),
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string, errorCode: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new AuthStateError(errorCode);
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    throw new AuthStateError(errorCode);
  }
}

function copiedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importEncryptionKey(encodedKey: string): Promise<CryptoKey> {
  const keyBytes = base64UrlToBytes(encodedKey, "auth-state-invalid-key");
  if (keyBytes.byteLength !== 32) throw new AuthStateError("auth-state-invalid-key");
  return crypto.subtle.importKey(
    "raw",
    copiedArrayBuffer(keyBytes),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptStorageState(
  value: unknown,
  encodedKey: string,
  updatedAt = new Date().toISOString(),
): Promise<EncryptedAuthState> {
  const storageState = validateStorageState(value);
  const key = await importEncryptionKey(encodedKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(storageState));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encryptionAdditionalData },
    key,
    plaintext,
  );
  return {
    version: encryptionVersion,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    updatedAt,
  };
}

function validateEnvelope(value: unknown): EncryptedAuthState {
  if (!isRecord(value)) throw new AuthStateError("auth-state-invalid-envelope");
  requireExactKeys(value, ["version", "iv", "ciphertext", "updatedAt"]);
  if (
    value.version !== encryptionVersion ||
    typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw new AuthStateError("auth-state-invalid-envelope");
  }
  if (base64UrlToBytes(value.iv, "auth-state-invalid-envelope").byteLength !== 12) {
    throw new AuthStateError("auth-state-invalid-envelope");
  }
  return {
    version: encryptionVersion,
    iv: value.iv,
    ciphertext: value.ciphertext,
    updatedAt: value.updatedAt,
  };
}

export async function decryptStorageState(
  value: unknown,
  encodedKey: string,
): Promise<{ storageState: StorageState; updatedAt: string }> {
  const envelope = validateEnvelope(value);
  const key = await importEncryptionKey(encodedKey);
  const iv = base64UrlToBytes(envelope.iv, "auth-state-invalid-envelope");
  const ciphertext = base64UrlToBytes(envelope.ciphertext, "auth-state-invalid-envelope");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: copiedArrayBuffer(iv),
        additionalData: encryptionAdditionalData,
      },
      key,
      copiedArrayBuffer(ciphertext),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    return { storageState: validateStorageState(parsed), updatedAt: envelope.updatedAt };
  } catch (error) {
    if (error instanceof AuthStateError) throw error;
    throw new AuthStateError("auth-state-decryption-failed");
  }
}

export function authStateMetadata(
  storageState: StorageState,
  updatedAt: string,
): AuthStateMetadata {
  const domains = new Set(storageState.cookies.map((cookie) => cookie.domain.toLowerCase()));
  for (const origin of storageState.origins) domains.add(new URL(origin.origin).hostname);
  return {
    cookieCount: storageState.cookies.length,
    domains: [...domains].sort(),
    updatedAt,
  };
}
