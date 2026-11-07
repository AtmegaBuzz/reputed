import {
  GAS,
  REPUTATION_REGISTRY,
  hbarForGas,
  reputationRegistryAbi,
  serializeReviewFile,
  type AgentDetail,
  type Review,
  type ReviewFile,
  type ReviewFileResponse,
} from '@reputed/shared';
import { decodeErrorResult, decodeEventLog, encodeFunctionData, getAbiItem, getAddress, keccak256, recoverMessageAddress, toEventSelector, type Hex } from 'viem';
import { agentIdOf, loadAgent, requireTinybar, TINYBAR_PER_HBAR, type AgentContext } from './context';
import { ReputedAgentError } from './errors';
import type { TxOutcome } from './gateway';
import type { ContractResult } from './mirror';
import { checkOwnPayment, toMirrorTransactionId } from './payments';

// Reviewing another agent: the same three steps as the web app's review modal, done by the agent's own
// account. 1) Build the review file and sign its exact bytes (EIP-191). 2) POST it to the Reputed
// server, which publishes it to HCS and returns its hcs:// URI and keccak hash. 3) Send giveFeedback
// to the ERC-8004 Reputation Registry citing that URI and hash. The scorer later reads the file back
// and counts the review only if the reviewer is human-backed, paid the agent first, and is not backed
// by the agent's own creator; the checks before step 1 refuse reviews that would fail those rules, so
// no gas is spent on a review that cannot count.

export interface ReviewInput {
  /** 0 to 100, a whole number. */
  value: number;
  /** `quality` (the default) or `misconduct`. Only misconduct reports can confirm a penalty. */
  tag1?: 'quality' | 'misconduct';
  /** A category: `accuracy`, `speed`, `uptime`, `communication`; or `fraud`, `failed-settlement`, `other` for misconduct. */
  tag2: string;
  comment?: string;
  /**
   * The payment this review is for, as returned by `pay()`. Without one the review is recorded but
   * not counted. Each payment counts for one review only.
   */
  proofOfPayment?: string;
  /** The endpoint that was used. Defaults to the agent's first registered endpoint. */
  endpoint?: string;
}

export interface ReviewReceipt {
  /** The agent that was reviewed. */
  agentId: string;
  /** This review's index among this account's reviews of that agent: with the agent and reviewer, it names the review. */
  feedbackIndex: number;
  feedbackUri: string;
  feedbackHash: Hex;
  /** The giveFeedback transaction, Mirror form. */
  transactionId: string;
  value: number;
}

export interface ReviewOutcome {
  review: Review;
  /** The reviewed agent as the server scored it with this review in. */
  agent: AgentDetail;
}

/** The server's limits (apps/server/src/routes/reviewFile.ts): HCS caps a message at 1,024 bytes. */
const MAX_FILE_BYTES = 1024;
const MAX_COMMENT_CHARS = 512;
const MAX_ENDPOINT_CHARS = 256;
const TAG2 = /^[a-z0-9-]{1,32}$/;
const HEADROOM_TINYBAR = 10_000_000n;
const RESULT_POLLS = 40;
const RESULT_GAP_MS = 1_500;
const NEW_FEEDBACK = toEventSelector(getAbiItem({ abi: reputationRegistryAbi, name: 'NewFeedback' }));

function invalid(message: string): never {
  throw new ReputedAgentError('INVALID_ARGUMENT', message);
}

function validate(input: ReviewInput): { tag1: 'quality' | 'misconduct'; comment: string | undefined } {
  if (!Number.isInteger(input.value) || input.value < 0 || input.value > 100) invalid(`A review value is a whole number from 0 to 100, got ${String(input.value)}.`);
  const tag1 = input.tag1 ?? 'quality';
  if (tag1 !== 'quality' && tag1 !== 'misconduct') invalid(`tag1 must be "quality" or "misconduct", got "${String(tag1)}".`);
  if (typeof input.tag2 !== 'string' || !TAG2.test(input.tag2)) invalid('tag2 must be 1 to 32 characters of a-z, 0-9 and "-", such as "accuracy".');
  const comment = input.comment?.trim() || undefined;
  if (comment !== undefined && comment.length > MAX_COMMENT_CHARS) invalid(`A comment can be at most ${MAX_COMMENT_CHARS} characters.`);
  return { tag1, comment };
}

/** The first endpoint the agent registered, as the web app's review modal picks it. */
function defaultEndpoint(agent: AgentDetail): string | undefined {
  const { a2a, mcp, web } = agent.endpoints;
  return a2a ?? mcp ?? web;
}

async function waitForResult(ctx: AgentContext, tx: TxOutcome): Promise<ContractResult> {
  if (tx.status !== 'SUCCESS' && tx.status !== 'CONTRACT_REVERT_EXECUTED') {
    throw new ReputedAgentError('TRANSACTION_FAILED', `Hedera ended transaction ${tx.transactionId} with ${tx.status}.`, { transactionId: tx.transactionId });
  }
  for (let attempt = 0; attempt < RESULT_POLLS; attempt++) {
    const result = await ctx.mirror.getContractResult(tx.transactionId);
    if (result?.result) return result;
    await ctx.sleep(RESULT_GAP_MS);
  }
  throw new ReputedAgentError(
    'TIMEOUT',
    `Review transaction ${tx.transactionId} was submitted but the Mirror Node has not reported its result. Look it up on HashScan before reviewing again.`,
    { transactionId: tx.transactionId },
  );
}

/** The registry's revert reason, from Error(string) or a custom error, or the Mirror Node's plain text. */
function revertReason(result: ContractResult): string {
  const data = result.error_message;
  if (!data) return result.result;
  if (!data.startsWith('0x')) return data;
  try {
    const decoded = decodeErrorResult({ abi: reputationRegistryAbi, data: data as Hex });
    const args = (decoded.args ?? []).map(String).join(', ');
    return args ? `${decoded.errorName}(${args})` : decoded.errorName;
  } catch {
    return result.result;
  }
}

function feedbackIndexFrom(result: ContractResult): number | null {
  for (const log of result.logs) {
    if (log.topics[0]?.toLowerCase() !== NEW_FEEDBACK) continue;
    try {
      const event = decodeEventLog({ abi: reputationRegistryAbi, eventName: 'NewFeedback', data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
      return Number((event.args as { feedbackIndex: bigint }).feedbackIndex);
    } catch {
      // Not the registry's event after all: keep looking.
    }
  }
  return null;
}

/**
 * Reviews another agent on-chain. Not retried: if it throws TIMEOUT, the review may still land, so
 * look the transaction up before calling it again (every call is a new review).
 */
export async function review(ctx: AgentContext, agentId: string | number | bigint, input: ReviewInput): Promise<ReviewReceipt> {
  const id = agentIdOf(agentId);
  const { tag1, comment } = validate(input);

  // The checks the registry and the scorer would apply, made before anything is signed or spent.
  const agent = await loadAgent(ctx, id);
  if (getAddress(agent.owner) === ctx.owner) {
    throw new ReputedAgentError('SELF_REVIEW', `Agent ${id} belongs to this account, and the registry does not accept reviews of your own agent.`);
  }
  if (agent.creator && getAddress(agent.creator) === ctx.creator) {
    throw new ReputedAgentError(
      'SAME_CREATOR',
      `Agent ${id} is backed by the same human as this agent (${ctx.creator}), so the scorer would not count the review.`,
    );
  }
  let proofOfPayment: string | undefined;
  if (input.proofOfPayment !== undefined) {
    if (!agent.wallet) throw new ReputedAgentError('PAYMENT_NOT_FOUND', `Agent ${id} has no wallet, so no payment to it can be verified.`);
    const check = await checkOwnPayment(ctx, input.proofOfPayment, agent.wallet);
    if (!check.ok) throw new ReputedAgentError('PAYMENT_NOT_FOUND', `${check.message} The scorer would not count this review.`);
    proofOfPayment = toMirrorTransactionId(input.proofOfPayment)!;
  }
  const endpoint = (input.endpoint ?? defaultEndpoint(agent) ?? `agent:${id}`).trim();
  if (!endpoint || endpoint.length > MAX_ENDPOINT_CHARS) invalid(`endpoint must be 1 to ${MAX_ENDPOINT_CHARS} characters.`);

  // 1) The file, and the reviewer's signature over its exact bytes.
  const caip = (address: string) => `eip155:${ctx.config.chainId}:${getAddress(address)}`;
  const file: ReviewFile = {
    agentRegistry: caip(ctx.config.identityRegistry),
    agentId: id,
    clientAddress: caip(ctx.owner),
    createdAt: new Date(ctx.now()).toISOString(),
    value: input.value,
    valueDecimals: 0,
    tag1,
    tag2: input.tag2,
    endpoint,
    ...(comment !== undefined ? { comment } : {}),
    ...(proofOfPayment !== undefined ? { proofOfPayment } : {}),
  };
  const bytes = serializeReviewFile(file);
  if (bytes.length >= MAX_FILE_BYTES) invalid(`The review file is ${bytes.length} bytes; it must be under ${MAX_FILE_BYTES}. Shorten the comment.`);
  const signature = await ctx.gateway.signMessage(bytes);
  // The giveFeedback sender must be the address that signed: an account whose EVM address is not its
  // key's (a long-zero address) cannot review, and it is better to learn that before posting.
  if ((await recoverMessageAddress({ message: { raw: bytes }, signature })) !== ctx.owner) {
    throw new ReputedAgentError(
      'UNSUPPORTED_KEY',
      `Account ${ctx.gateway.accountId} sends transactions as ${ctx.owner}, which is not the address of its key, so it cannot sign a review file.`,
    );
  }

  await requireTinybar(ctx, BigInt(Math.ceil(hbarForGas(GAS.giveFeedback) * Number(TINYBAR_PER_HBAR))) + HEADROOM_TINYBAR, `review agent ${id}`);

  // 2) Published to HCS by the server.
  const posted = await ctx.postJson<ReviewFileResponse>('/api/review-file', { ...file, signature });
  if (posted.feedbackHash?.toLowerCase() !== keccak256(bytes).toLowerCase() || typeof posted.feedbackUri !== 'string') {
    throw new ReputedAgentError('API_ERROR', 'The Reputed server returned a review hash that does not match the signed file.');
  }

  // 3) On-chain, from this agent's account.
  const registry = await ctx.mirror.getContractId(REPUTATION_REGISTRY);
  if (!registry) throw new ReputedAgentError('MIRROR_ERROR', 'The Mirror Node does not know the Reputation Registry.');
  const data = encodeFunctionData({
    abi: reputationRegistryAbi,
    functionName: 'giveFeedback',
    args: [BigInt(id), BigInt(input.value), 0, tag1, input.tag2, endpoint, posted.feedbackUri, posted.feedbackHash],
  });
  const tx = await ctx.gateway.executeContract(registry, data, GAS.giveFeedback);
  const result = await waitForResult(ctx, tx);
  if (result.result !== 'SUCCESS') {
    const reason = revertReason(result);
    const code = /self/i.test(reason) ? 'SELF_REVIEW' : 'TRANSACTION_FAILED';
    throw new ReputedAgentError(code, `The Reputation Registry refused the review: ${reason}.`, { transactionId: tx.transactionId });
  }
  const feedbackIndex = feedbackIndexFrom(result);
  if (feedbackIndex === null) {
    throw new ReputedAgentError('TRANSACTION_FAILED', `Transaction ${tx.transactionId} succeeded but logged no NewFeedback event.`, { transactionId: tx.transactionId });
  }
  return { agentId: id, feedbackIndex, feedbackUri: posted.feedbackUri, feedbackHash: posted.feedbackHash, transactionId: tx.transactionId, value: input.value };
}

export interface WaitForReviewOptions {
  /** Defaults to 3 minutes: the server indexes every few seconds, then fetches the file and payment. */
  timeoutMs?: number;
  /** Defaults to 3 seconds. */
  intervalMs?: number;
}

/**
 * Waits until the Reputed server has scored a review this agent gave, and returns it with the agent's
 * new score. `review.counted` says whether it counted, and `review.exclusionReason` why not.
 */
export async function waitForReview(ctx: AgentContext, receipt: Pick<ReviewReceipt, 'agentId' | 'feedbackIndex'>, options: WaitForReviewOptions = {}): Promise<ReviewOutcome> {
  const deadline = ctx.now() + (options.timeoutMs ?? 180_000);
  const interval = options.intervalMs ?? 3_000;
  const id = agentIdOf(receipt.agentId);
  while (true) {
    const agent = await loadAgent(ctx, id);
    const found = agent.reviews.find((item) => item.feedbackIndex === receipt.feedbackIndex && getAddress(item.clientAddress) === ctx.owner);
    if (found) return { review: found, agent };
    if (ctx.now() + interval > deadline) {
      throw new ReputedAgentError('TIMEOUT', `The Reputed server has not scored review ${receipt.feedbackIndex} of agent ${id} yet. It may still be indexing; check again later.`);
    }
    await ctx.sleep(interval);
  }
}
