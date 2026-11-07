import { AccountId, Client, Hbar, HbarUnit, PrivateKey, TransferTransaction } from '@hiero-ledger/sdk';
import { HEDERA_TESTNET } from '@reputed/shared';

// The funder creates the agent accounts and tops them up. Sending HBAR to a new EVM address creates
// the account (a "hollow" account with that address as its alias); the agent's first transaction,
// signed with its key, completes it. Such an account's EVM address comes from its key, which is what
// signing review files needs.

/** Measured on testnet: registering about 0.56 HBAR, linking about 1.55. Each needs 1.9 available when sent. */
export const ONBOARDING_HBAR = 2.5;
/** A review reserves 1 HBAR of gas (plus headroom) when it is sent; a payment needs its amount plus the fee. */
export const RESERVE_HBAR = 1.3;
/** One job as the hirer: a review (about 0.25 HBAR) and the 0.1 HBAR payment, with fees. Income is not counted. */
export const PER_ROUND_HBAR = 0.45;
/** What the funder pays on top when a transfer creates the account (measured 0.7434 HBAR on testnet, Nov 2026). */
export const ACCOUNT_CREATE_FEE_HBAR = 0.75;
/** Top-ups go this far over the minimum, so a run does not top up by crumbs every time. */
export const TOP_UP_BUFFER_HBAR = 1;

export interface MirrorAccount {
  accountId: string;
  tinybar: bigint;
}

export const hbar = (tinybar: bigint): number => Number(tinybar) / 1e8;

export async function findAccount(evmOrId: string): Promise<MirrorAccount | null> {
  const res = await fetch(`${HEDERA_TESTNET.mirrorNode}/api/v1/accounts/${evmOrId}`, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The Mirror Node answered ${res.status} for account ${evmOrId}.`);
  const body = (await res.json()) as { account: string; balance: { balance: number } };
  return { accountId: body.account, tinybar: BigInt(body.balance.balance) };
}

/** What an agent should hold before a run of `rounds` rounds. */
export function neededHbar(rounds: number, onboarded: boolean): number {
  return (onboarded ? 0 : ONBOARDING_HBAR) + RESERVE_HBAR + rounds * PER_ROUND_HBAR;
}

/** HBAR to send so the agent can finish the run, or 0 if it already can. Rounded up to 0.1 HBAR. */
export function topUpFor(balanceHbar: number, rounds: number, onboarded: boolean): number {
  const need = neededHbar(rounds, onboarded);
  if (balanceHbar >= need) return 0;
  // The epsilon keeps float noise (3.1 + 1 - 3 = 1.1000000000000005) from rounding a tenth up.
  return Math.ceil((need + TOP_UP_BUFFER_HBAR - balanceHbar) * 10 - 1e-9) / 10;
}

export interface Funder {
  accountId: string;
  client: Client;
}

export async function connectFunder(key: string, evmAddress: string): Promise<Funder & { tinybar: bigint }> {
  const account = await findAccount(evmAddress);
  if (!account) throw new Error(`The funder ${evmAddress} has no testnet account. Send it HBAR first.`);
  const client = Client.forTestnet().setOperator(account.accountId, PrivateKey.fromStringECDSA(key.replace(/^0x/, '')));
  return { accountId: account.accountId, client, tinybar: account.tinybar };
}

/** Sends `amountHbar` to an existing account ID, or to an EVM address, which creates the account. Returns the transaction ID. */
export async function send(funder: Funder, to: { accountId: string } | { evmAddress: string }, amountHbar: number, memo: string): Promise<string> {
  const amount = Hbar.from(Math.round(amountHbar * 1e8).toString(), HbarUnit.Tinybar);
  const target = 'accountId' in to ? AccountId.fromString(to.accountId) : AccountId.fromEvmAddress(0, 0, to.evmAddress);
  const response = await new TransferTransaction()
    .addHbarTransfer(AccountId.fromString(funder.accountId), amount.negated())
    .addHbarTransfer(target, amount)
    .setTransactionMemo(memo)
    .execute(funder.client);
  const receipt = await response.getReceipt(funder.client);
  if (receipt.status.toString() !== 'SUCCESS') throw new Error(`Funding ended with ${receipt.status.toString()}.`);
  return response.transactionId.toString();
}

/** Waits until the Mirror Node shows the account holding at least `minTinybar`. */
export async function waitForBalance(evmAddress: string, minTinybar: bigint, timeoutMs = 90_000): Promise<MirrorAccount> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const account = await findAccount(evmAddress).catch(() => null);
    if (account && account.tinybar >= minTinybar) return account;
    if (Date.now() > deadline) throw new Error(`The Mirror Node has not shown the funding of ${evmAddress} after ${timeoutMs / 1000} s.`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}
