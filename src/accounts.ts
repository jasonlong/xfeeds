import accountsJson from "../accounts.json" with { type: "json" };

export interface Account {
  handle: string;
  name: string;
}

const handlePattern = /^[A-Za-z0-9_]{1,15}$/;

export const accounts: readonly Account[] = Object.freeze(
  accountsJson.map((account) => {
    if (!handlePattern.test(account.handle)) {
      throw new Error(`Invalid configured handle: ${account.handle}`);
    }
    return Object.freeze({ ...account });
  }),
);

export const accountsByHandle = new Map(
  accounts.map((account) => [account.handle.toLowerCase(), account]),
);

export function configuredAccount(handle: string): Account | undefined {
  return accountsByHandle.get(handle.toLowerCase());
}
