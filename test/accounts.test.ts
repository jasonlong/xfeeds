import { describe, expect, it } from "vitest";
import { accounts, configuredAccount } from "../src/accounts";

describe("account configuration", () => {
  it("contains the 15 supplied accounts exactly once", () => {
    expect(accounts).toHaveLength(15);
    expect(new Set(accounts.map((account) => account.handle.toLowerCase())).size).toBe(15);
  });

  it("resolves handles case-insensitively", () => {
    expect(configuredAccount("AREdotNA")?.name).toBe("Are.na");
    expect(configuredAccount("readwisereader")?.handle).toBe("ReadwiseReader");
    expect(configuredAccount("PAPER")?.handle).toBe("paper");
  });
});
