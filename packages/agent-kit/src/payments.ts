import { getAddress, isAddress } from 'viem';
import { agentIdOf, loadAgent, requireTinybar, type AgentContext } from './context';
import { ReputedAgentError } from './errors';
import type { MirrorTransaction } from './mirror';

// Paying another agent, and checking a payment someone says they made. Both read the result from the
// Mirror Node, because that is what the Reputed scorer reads: a review counts only if the reviewer's
// account lost what the reviewed agent's wallet gained, in a transaction that succeeded before the
// review (apps/server/src/scoring/filter.ts, verifyPayment). The checks here apply the same rule, so a
// payment this package accepts is one the scorer accepts too.

export interface PaymentReceipt {
  /** Mirror form, 0.0.payer-seconds-nanos. Pass it to `review()` as `proofOfPayment`. */
  transactionId: string;
  /** The agent that was paid. */
  agentId: string;
  /** The Hedera account behind the agent's wallet, which received the HBAR. */
  to: string;
  tinybar: bigint;
  /** Mirror Node consensus time, seconds.nanos. */
  consensusTimestamp: string;
}

export interface PayOptions {
  /** Up to 100 bytes, shown on HashScan. */
  memo?: string;
}

export type PaymentCheckFailure =
  | 'INVALID_TRANSACTION_ID' // not 0.0.x@s.n or 0.0.x-s-n
  | 'PAYER_UNKNOWN' // the Mirror Node has no account for `from`
  | 'NOT_FOUND' // the Mirror Node has no such transaction (yet)
  | 'FAILED' // the transaction did not succeed, so it moved nothing
  | 'WRONG_MEMO' // it does not carry the memo that ties it to this job
  | 'NO_WALLET' // this agent has no registered wallet, so no payment to it counts
  | 'WRONG_PARTIES' // it did not move HBAR from `from` to this agent
  | 'TOO_SMALL'; // it did, but less than `minHbar`

export type PaymentCheck =
  | { ok: true; transactionId: string; tinybar: bigint; consensusTimestamp: string }
  | { ok: false; reason: PaymentCheckFailure; message: string };

export interface VerifyPaymentOptions {
  /** Who should have paid: an EVM address or a 0.0.x account ID. */
  from: string;
  /** The least this agent must have received. Defaults to any positive amount. */
  minHbar?: number;
  /**
   * The exact memo the payment must carry, such as a job ID. This ties a payment to one job: without
   * it, anyone who sees the payer pay you could cite that payment for a job of their own first.
   */
  memo?: string;
  /** How long to wait for the Mirror Node to index the transaction. Defaults to 30 seconds. */
  waitMs?: number;
}

const SDK_FORM = /^(\d+\.\d+\.\d+)@(\d{1,19})\.(\d{1,9})$/;
const MIRROR_FORM = /^(\d+\.\d+\.\d+)-(\d{1,19})-(\d{1,9})$/;
const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;
/** Hedera caps a transaction memo at 100 bytes. */
const MAX_MEMO_BYTES = 100;
/** Covers the transfer fee, a small fraction of a cent, with room to spare. */
const FEE_HEADROOM_TINYBAR = 10_000_000n;
const INDEX_POLLS = 40;
const INDEX_GAP_MS = 1_500;

// The Mirror Node's limits, as in apps/server/src/scoring/txid.ts: past them it answers 400, or 503
// for a valid start whose 35-minute lookup range overflows int64. Either would surface as a Mirror
// Node outage for input a counterparty controls, so such IDs are refused here.
const MAX_SHARD = 1023n;
const MAX_REALM = 65535n;
const MAX_ACCOUNT_NUM = 2n ** 38n - 1n;
const MAX_VALID_START_SECONDS = 9_000_000_000n;

function isMirrorAccount(account: string): boolean {
  const [shard, realm, num] = account.split('.').map(BigInt) as [bigint, bigint, bigint];
  return shard <= MAX_SHARD && realm <= MAX_REALM && num <= MAX_ACCOUNT_NUM && shard + realm + num > 0n;
}

/**
 * SDK `0.0.x@s.n` or Mirror `0.0.x-s-n` to the Mirror form, nanos zero-padded the way the server
 * normalizes them (scoring/txid.ts), so one payment has one spelling. Null for anything else.
 */
export function toMirrorTransactionId(raw: string): string | null {
  const match = SDK_FORM.exec(raw.trim()) ?? MIRROR_FORM.exec(raw.trim());
  if (!match) return null;
  const [, account, seconds, nanos] = match;
  if (!isMirrorAccount(account!) || BigInt(seconds!) > MAX_VALID_START_SECONDS) return null;
  return `${account}-${seconds}-${nanos!.padStart(9, '0')}`;
}

/** HBAR to tinybar, refusing what Hedera cannot represent. */
export function hbarToTinybar(hbar: number, what = 'The amount'): bigint {
  if (typeof hbar !== 'number' || !Number.isFinite(hbar) || hbar <= 0) {
    throw new ReputedAgentError('INVALID_ARGUMENT', `${what} must be a positive number of HBAR, got ${String(hbar)}.`);
  }
  const scaled = hbar * 1e8;
  const tinybar = Math.round(scaled);
  if (Math.abs(scaled - tinybar) > 1e-6 || !Number.isSafeInteger(tinybar)) {
    throw new ReputedAgentError('INVALID_ARGUMENT', `${what} can have at most 8 decimal places (1 tinybar), got ${hbar}.`);
  }
  return BigInt(tinybar);
}

/**
 * Net HBAR per account over every entry that succeeded, fees included. A payer's net loss is the
 * amount plus the fee; comparing it with the payee's gain (rather than looking for any negative
 * balance) is what stops a fee payer on someone else's transfer from passing as the payer.
 */
function netFlows(entries: MirrorTransaction[]): Map<string, bigint> {
  const flows = new Map<string, bigint>();
  for (const entry of entries) {
    if (entry.result !== 'SUCCESS') continue;
    for (const { account, amount } of entry.transfers ?? []) {
      flows.set(account, (flows.get(account) ?? 0n) + BigInt(amount));
    }
  }
  return flows;
}

/** Polls until the Mirror Node has indexed the transaction. 404 means "not yet", so it is not an error. */
async function findTransaction(ctx: AgentContext, transactionId: string, waitMs: number): Promise<MirrorTransaction[] | null> {
  const deadline = ctx.now() + waitMs;
  while (true) {
    const entries = await ctx.mirror.getTransaction(transactionId);
    if (entries) return entries;
    if (ctx.now() + INDEX_GAP_MS > deadline) return null;
    await ctx.sleep(INDEX_GAP_MS);
  }
}

/** The rule from the scorer: the payee gained, and the payer lost at least what the payee gained. */
function judge(
  entries: MirrorTransaction[],
  transactionId: string,
  payer: string,
  payee: string,
  minTinybar: bigint,
  memo?: string,
): PaymentCheck {
  const succeeded = entries.filter((entry) => entry.result === 'SUCCESS');
  if (succeeded.length === 0) {
    return { ok: false, reason: 'FAILED', message: `Transaction ${transactionId} ended with ${entries[0]?.result ?? 'no result'}, so it moved no HBAR.` };
  }
  if (memo !== undefined) {
    const found = Buffer.from(entries[0]?.memo_base64 ?? '', 'base64').toString('utf8');
    if (found !== memo) return { ok: false, reason: 'WRONG_MEMO', message: `Transaction ${transactionId} has the memo "${found}", not "${memo}".` };
  }
  const flows = netFlows(succeeded);
  const received = flows.get(payee) ?? 0n;
  const sent = -(flows.get(payer) ?? 0n);
  if (received <= 0n || sent < received) {
    return { ok: false, reason: 'WRONG_PARTIES', message: `Transaction ${transactionId} does not move HBAR from ${payer} to ${payee}.` };
  }
  if (received < minTinybar) {
    return {
      ok: false,
      reason: 'TOO_SMALL',
      message: `Transaction ${transactionId} paid ${received} tinybar, less than the ${minTinybar} tinybar asked for.`,
    };
  }
  const consensusTimestamp = succeeded.map((entry) => entry.consensus_timestamp).sort().at(-1)!;
  return { ok: true, transactionId, tinybar: received, consensusTimestamp };
}

/** The Hedera account behind an EVM address or account ID, or null if the Mirror Node has none. */
async function accountOf(ctx: AgentContext, idOrAddress: string): Promise<string | null> {
  if (ACCOUNT_ID.test(idOrAddress)) return idOrAddress;
  if (!isAddress(idOrAddress, { strict: false })) return null;
  return (await ctx.mirror.getAccount(getAddress(idOrAddress)))?.account ?? null;
}

/**
 * Pays another agent in HBAR, from this agent's account to the wallet the agent registered, and waits
 * until the Mirror Node shows it, so the transaction ID can be cited in a review straight away.
 * It does not check the agent: call `verifyCounterparty` first.
 */
export async function pay(
  ctx: AgentContext,
  agentId: string | number | bigint,
  hbar: number,
  options: PayOptions = {},
): Promise<PaymentReceipt> {
  const id = agentIdOf(agentId);
  const tinybar = hbarToTinybar(hbar);
  if (options.memo !== undefined && new TextEncoder().encode(options.memo).length > MAX_MEMO_BYTES) {
    throw new ReputedAgentError('INVALID_ARGUMENT', `A transaction memo can be at most ${MAX_MEMO_BYTES} bytes.`);
  }

  const agent = await loadAgent(ctx, id);
  if (!agent.wallet) {
    throw new ReputedAgentError('NO_WALLET', `Agent ${id} has no wallet to pay: its owner changed and the new owner has not set one.`);
  }
  if (getAddress(agent.wallet) === ctx.owner) {
    throw new ReputedAgentError('INVALID_ARGUMENT', `Agent ${id}'s wallet is this account, so there is no one to pay.`);
  }
  const to = await accountOf(ctx, agent.wallet);
  if (!to) throw new ReputedAgentError('NO_WALLET', `The Mirror Node has no Hedera account for agent ${id}'s wallet ${agent.wallet}.`);

  await requireTinybar(ctx, tinybar + FEE_HEADROOM_TINYBAR, `pay agent ${id}`);
  const tx = await ctx.gateway.transferHbar(to, tinybar, options.memo);
  const transactionId = toMirrorTransactionId(tx.transactionId) ?? tx.transactionId;
  if (tx.status !== 'SUCCESS') {
    throw new ReputedAgentError('TRANSACTION_FAILED', `Paying agent ${id} failed: ${tx.status}.`, { transactionId });
  }

  const entries = await findTransaction(ctx, transactionId, INDEX_POLLS * INDEX_GAP_MS);
  if (!entries) {
    throw new ReputedAgentError(
      'TIMEOUT',
      `Payment ${transactionId} succeeded, but the Mirror Node has not shown it yet. Do not pay again: cite this transaction ID once it appears.`,
      { transactionId },
    );
  }
  const check = judge(entries, transactionId, ctx.gateway.accountId, to, tinybar);
  if (!check.ok) throw new ReputedAgentError('TRANSACTION_FAILED', check.message, { transactionId });
  return { transactionId, agentId: id, to, tinybar: check.tinybar, consensusTimestamp: check.consensusTimestamp };
}

/**
 * Checks that `from` paid this agent's account in the given transaction: what to do before delivering
 * paid work. A failed check is a returned value with a reason, like `verifyCounterparty`; only an
 * unreachable Mirror Node throws. It does not remember payments: refuse a transaction ID you have
 * already accepted, or one that reached consensus before you quoted the job.
 */
export async function verifyPayment(ctx: AgentContext, transactionId: string, options: VerifyPaymentOptions): Promise<PaymentCheck> {
  const id = toMirrorTransactionId(transactionId);
  if (!id) {
    return { ok: false, reason: 'INVALID_TRANSACTION_ID', message: `"${transactionId}" is not a Hedera transaction ID (0.0.x@seconds.nanos).` };
  }
  const minTinybar = options.minHbar === undefined ? 1n : hbarToTinybar(options.minHbar, 'minHbar');
  const payer = await accountOf(ctx, options.from);
  if (!payer) return { ok: false, reason: 'PAYER_UNKNOWN', message: `The Mirror Node has no Hedera account for ${options.from}.` };
  // The scorer credits payments to the agent's registered wallet, which need not be the operator.
  const me = await loadAgent(ctx, ctx.agentId);
  const payee = me.wallet ? await accountOf(ctx, me.wallet) : null;
  if (!payee) return { ok: false, reason: 'NO_WALLET', message: `Agent ${ctx.agentId} has no registered wallet with a Hedera account, so no payment to it counts.` };

  const entries = await findTransaction(ctx, id, options.waitMs ?? 30_000);
  if (!entries) return { ok: false, reason: 'NOT_FOUND', message: `The Mirror Node has no transaction ${id}.` };
  return judge(entries, id, payer, payee, minTinybar, options.memo);
}

/** For review(): did this agent's own account pay that agent's wallet in this transaction? */
export async function checkOwnPayment(ctx: AgentContext, transactionId: string, wallet: string): Promise<PaymentCheck> {
  const id = toMirrorTransactionId(transactionId);
  if (!id) {
    return { ok: false, reason: 'INVALID_TRANSACTION_ID', message: `"${transactionId}" is not a Hedera transaction ID (0.0.x@seconds.nanos).` };
  }
  const payee = await accountOf(ctx, wallet);
  if (!payee) return { ok: false, reason: 'WRONG_PARTIES', message: `The Mirror Node has no Hedera account for the agent's wallet ${wallet}.` };
  const entries = await findTransaction(ctx, id, 30_000);
  if (!entries) return { ok: false, reason: 'NOT_FOUND', message: `The Mirror Node has no transaction ${id}.` };
  return judge(entries, id, ctx.gateway.accountId, payee, 1n);
}

