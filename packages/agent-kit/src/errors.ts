/** Everything that can stop onboarding, a payment, a review or a reputation call, in words a developer can act on. */
export type ReputedAgentErrorCode =
  | 'INVALID_ARGUMENT' // a bad option, caught before any request
  | 'INVALID_API_KEY' // not an rpk_… key
  | 'NO_OPERATOR' // the Client has no operator account, so it cannot sign
  | 'NOT_CONFIGURED' // no API URL, or the server has no CreatorRegistry yet
  | 'API_ERROR' // the Reputed API was unreachable or answered badly
  | 'MIRROR_ERROR' // the Mirror Node was unreachable or answered badly
  | 'GRANT_NOT_FOUND' // the key was never authorized on-chain (or the transaction is still settling)
  | 'GRANT_EXPIRED'
  | 'GRANT_REVOKED'
  | 'GRANT_EXHAUSTED' // the key has already linked its maximum number of agents
  | 'INSUFFICIENT_HBAR' // the agent account cannot pay for the next transaction
  | 'LINKED_TO_OTHER_CREATOR' // the agent already belongs to someone else
  | 'OWNER_MISMATCH' // the registry's owner is not the account we expected
  | 'TRANSACTION_FAILED' // Hedera rejected or reverted a transaction
  | 'TIMEOUT' // a transaction was submitted but its result never showed up
  | 'AGENT_NOT_FOUND' // the agent to pay or review is unknown to Reputed
  | 'NO_WALLET' // the agent has no wallet to pay (its NFT was transferred)
  | 'SELF_REVIEW' // this account owns the agent it tried to review, which the registry refuses
  | 'SAME_CREATOR' // both agents are backed by the same human, so the review would not count
  | 'PAYMENT_NOT_FOUND' // the cited payment does not show this account paying that agent
  | 'UNSUPPORTED_KEY'; // the operator cannot sign review files (not an ECDSA key for this EVM address)

export class ReputedAgentError extends Error {
  readonly code: ReputedAgentErrorCode;
  /** Set when the failure came with a transaction, so it can be looked up on HashScan. */
  readonly transactionId: string | undefined;

  constructor(code: ReputedAgentErrorCode, message: string, options: { cause?: unknown; transactionId?: string } = {}) {
    super(message, { cause: options.cause });
    this.name = 'ReputedAgentError';
    this.code = code;
    this.transactionId = options.transactionId;
  }
}
