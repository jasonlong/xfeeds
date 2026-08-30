import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  AuthStateError,
  decryptStorageState,
  encryptStorageState,
  filterStorageState,
  validateStorageState,
  type StorageState,
} from "../src/auth-state";

const key = Buffer.alloc(32, 7).toString("base64url");
const wrongKey = Buffer.alloc(32, 8).toString("base64url");

function state(): StorageState {
  return {
    cookies: [
      {
        name: "auth_token",
        value: "private-session-value",
        domain: ".x.com",
        path: "/",
        expires: 1_900_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "None",
      },
      {
        name: "theme",
        value: "dark",
        domain: "x.com",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [
      {
        origin: "https://x.com",
        localStorage: [{ name: "language", value: "en" }],
      },
    ],
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("Expected auth-state validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthStateError);
    expect((error as AuthStateError).code).toBe(code);
  }
}

describe("Cloudflare auth state", () => {
  it("round trips through an encrypted versioned envelope", async () => {
    const updatedAt = "2026-08-30T12:00:00.000Z";
    const envelope = await encryptStorageState(state(), key, updatedAt);

    expect(envelope).toMatchObject({ version: 1, updatedAt });
    expect(JSON.stringify(envelope)).not.toContain("private-session-value");
    await expect(decryptStorageState(envelope, key)).resolves.toEqual({
      storageState: state(),
      updatedAt,
    });
  });

  it("rejects an incorrect encryption key", async () => {
    const envelope = await encryptStorageState(state(), key);
    await expect(decryptStorageState(envelope, wrongKey)).rejects.toMatchObject({
      code: "auth-state-decryption-failed",
    });
  });

  it("requires a non-empty X auth token", () => {
    const value = state();
    value.cookies[0]!.value = "";
    expectCode(() => validateStorageState(value), "auth-state-missing-auth-token");
  });

  it("rejects unexpected cookie domains", () => {
    const value = state();
    value.cookies[1]!.domain = ".example.com";
    expectCode(() => validateStorageState(value), "auth-state-invalid-cookie");
  });

  it("rejects malformed and oversized state", () => {
    expectCode(() => validateStorageState(null), "auth-state-invalid");
    expectCode(
      () => validateStorageState({ ...state(), unexpected: true }),
      "auth-state-unexpected-field",
    );
    const oversized = state();
    oversized.cookies[0]!.value = "x".repeat(64 * 1024);
    expectCode(() => validateStorageState(oversized), "auth-state-too-large");
  });

  it("filters third-party state before validating a local profile snapshot", () => {
    const value = state();
    value.cookies.push({
      ...value.cookies[1]!,
      name: "third_party",
      domain: ".example.com",
    });
    value.origins.push({ origin: "https://example.com", localStorage: [] });

    expect(filterStorageState(value)).toEqual(state());
  });

  it("normalizes browser-produced fields before encrypting the refreshed state", () => {
    const value = state();
    const cookieWithBrowserField = {
      ...value.cookies[0]!,
      partitionKey: "https://x.com",
    };
    const originWithIndexedDb = {
      ...value.origins[0]!,
      indexedDB: [],
    };
    value.cookies[0] = cookieWithBrowserField;
    value.origins[0] = originWithIndexedDb;

    expect(filterStorageState(value)).toEqual(state());
  });
});
