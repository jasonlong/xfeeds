import { describe, expect, it } from "vitest";
import { accounts, configuredAccount } from "../src/accounts";

describe("account configuration", () => {
  it("contains the 13 supplied accounts exactly once", () => {
    expect(accounts).toHaveLength(13);
    expect(new Set(accounts.map((account) => account.handle.toLowerCase())).size).toBe(13);
  });

  it("resolves handles case-insensitively", () => {
    expect(configuredAccount("AREdotNA")?.name).toBe("Are.na");
    expect(configuredAccount("readwisereader")?.handle).toBe("ReadwiseReader");
  });
});
