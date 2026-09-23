import { describe, expect, it } from "vitest";
import { accounts, configuredAccount } from "../src/accounts";

describe("account configuration", () => {
  it("contains the 17 supplied accounts exactly once", () => {
    expect(accounts).toHaveLength(17);
    expect(new Set(accounts.map((account) => account.handle.toLowerCase())).size).toBe(17);
  });

  it("resolves handles case-insensitively", () => {
    expect(configuredAccount("AREdotNA")?.name).toBe("Are.na");
    expect(configuredAccount("readwisereader")?.handle).toBe("ReadwiseReader");
    expect(configuredAccount("PAPER")?.handle).toBe("paper");
    expect(configuredAccount("STEPHENHANEY")?.name).toBe("Stephen Haney");
    expect(configuredAccount("VLADMOROZ")?.name).toBe("Vlad Moroz");
  });
});
