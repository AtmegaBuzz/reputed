// Payment proofs as reviewers write them. Three spellings are accepted (SDK 0.0.x@s.n, Mirror
// 0.0.x-s-n, and a 32-byte EVM hash) and reduced to one Mirror transaction ID, which is the
// key the single-use check in classifyReviews runs on. The bounds below come from what Mirror
// can answer, so a made-up ID is rejected here instead of being retried as a mirror failure.
import type { ConsensusTimestamp } from './time.ts';

const SDK_FORM = /^(\d+\.\d+\.\d+)@(\d{1,19})\.(\d{1,9})$/;
const MIRROR_FORM = /^(\d+\.\d+\.\d+)-(\d{1,19})-(\d{1,9})$/;
const ETH_HASH = /^0x[0-9a-fA-F]{64}$/;

// The limits of Mirror Node's entity encoding: it answers 400 past them, and to 0.0.0.
const MAX_SHARD = 1023n;
const MAX_REALM = 65535n;
const MAX_ACCOUNT_NUM = 2n ** 38n - 1n;
// Mirror adds a 35-minute range to the valid start in nanoseconds. From 9223369937 on that overflows
// int64 and it answers 503, which is retryable, so one made-up ID would hold every epoch back.
const MAX_VALID_START_SECONDS = 9_000_000_000n;

function isMirrorAccount(account: string): boolean {
  const [shard, realm, num] = account.split('.').map(BigInt) as [bigint, bigint, bigint];
  return (
    shard <= MAX_SHARD &&
    realm <= MAX_REALM &&
    num <= MAX_ACCOUNT_NUM &&
    shard + realm + num > 0n
  );
}

/**
 * 0.0.x@s.n (SDK, wallets) to 0.0.x-s-n (Mirror Node, which answers 400 to the @ form).
 * Nanos are zero-padded so one transaction cannot be cited under two spellings.
 */
export function toMirrorTransactionId(raw: string): string | null {
  const match = SDK_FORM.exec(raw.trim()) ?? MIRROR_FORM.exec(raw.trim());
  if (!match) return null;
  const [, account, seconds, nanos] = match;
  if (!isMirrorAccount(account!) || BigInt(seconds!) > MAX_VALID_START_SECONDS) return null;
  return `${account}-${seconds}-${nanos!.padStart(9, '0')}`;
}

export function toSdkTransactionId(raw: string): string | null {
  const mirror = toMirrorTransactionId(raw);
  if (!mirror) return null;
  const [account, seconds, nanos] = mirror.split('-');
  return `${account}@${seconds}.${nanos}`;
}

/**
 * The ID web passes to hashscan.tx(). Only a 32-byte 0x hash and a consensus timestamp are known to
 * open there, so the timestamp stands in for anything else a log carries, such as a 48-byte hash.
 */
export function hashscanTxId(txHash: string, timestamp: ConsensusTimestamp): string {
  return ETH_HASH.test(txHash) ? txHash : timestamp;
}

export type PaymentProof =
  | { kind: 'transaction-id'; key: string }
  | { kind: 'eth-hash'; key: string };

/**
 * Payers sending from an EVM wallet only ever see the EVM hash, so it is accepted alongside the Hedera ID.
 * The key is the lookup key; reuse is checked on the resolved transaction ID, not on this.
 */
export function parsePaymentProof(raw: unknown): PaymentProof | null {
  if (typeof raw !== 'string') return null;
  const id = toMirrorTransactionId(raw);
  if (id) return { kind: 'transaction-id', key: id };
  const trimmed = raw.trim();
  if (ETH_HASH.test(trimmed)) return { kind: 'eth-hash', key: trimmed.toLowerCase() };
  return null;
}
