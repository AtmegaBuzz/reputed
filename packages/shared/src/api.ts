// The contract between server/ and web/. Change it only with both sides agreed.
export type Address = `0x${string}`;
export type Tier = 'Tier 1' | 'Tier 2' | 'Tier 3';

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED'
  | 'INVALID_PROOF'
  | 'ALREADY_REGISTERED'
  | 'WALLET_TAKEN'
  | 'WORLD_UNAVAILABLE'
  | 'CHAIN_ERROR'
  | 'INTERNAL_ERROR';

/**
 * Every non-2xx response has this body. RATE_LIMITED arrives as HTTP 429, or as 503 when a
 * server-wide budget is spent: posting reviews, or looking up agents not scored yet. Both carry a
 * retry-after header.
 */
export interface ApiError {
  code: ApiErrorCode;
  message: string;
}

export interface Score {
  value: number; // 0-100
  tier: Tier;
  /** True when the value is inherited from the creator: show the "New" badge. */
  isNew: boolean;
}

export interface AgentEndpoints {
  a2a?: string;
  mcp?: string;
  web?: string;
  x402PriceHbar?: number;
}

export type AgentStatus = 'active' | 'compromised' | 'operator-changed';

export interface AgentSummary {
  agentId: string; // uint256 as a decimal string
  name: string;
  description: string;
  image?: string;
  tags: string[];
  owner: Address;
  wallet: Address | null; // null after the agent NFT is transferred
  creator: Address | null; // null when not linked to a verified human
  humanBacked: boolean;
  score: Score;
  creatorScore: number | null;
  reviewsCounted: number;
  registeredAt: string; // ISO 8601
  acceptsX402: boolean;
  status: AgentStatus;
}

export interface Credential {
  tokenId: string; // 0.0.x
  serial: number;
  kind: 'human-backed' | 'milestone';
  title: string;
  issuedAt: string;
  revoked: boolean;
  /** CreatorRegistry, which issues every credential. */
  issuer: Address;
  /** The transaction that minted it, for hashscan.tx() (a consensus timestamp). */
  txId?: string;
}

export type ExclusionReason =
  | 'revoked'
  | 'hash-mismatch'
  | 'not-human-backed'
  | 'payment-not-found'
  | 'same-creator'
  | 'invalid-value'; // on-chain value outside 0-100

/** The latest reply from the agent's owner or wallet. Anyone can append a response on-chain. */
export interface ReviewResponse {
  responder: Address;
  uri: string;
  hash: `0x${string}`;
  text?: string;
  createdAt: string;
}

export interface Review {
  clientAddress: Address;
  feedbackIndex: number;
  value: number; // always normalised to 0-100
  tag1: string; // 'quality' | 'misconduct'
  tag2: string;
  endpoint: string;
  comment?: string;
  createdAt: string;
  paymentVerified: boolean;
  counted: boolean;
  exclusionReason?: ExclusionReason;
  reviewerHumanBacked: boolean;
  feedbackUri: string;
  txId: string; // 0x hash or consensus timestamp: both open with hashscan.tx()
  response?: ReviewResponse;
}

export interface AgentDetail extends AgentSummary {
  endpoints: AgentEndpoints;
  agentUri: string;
  /** The transaction that registered the agent and minted its ERC-8004 NFT, for hashscan.tx(). */
  registrationTxId?: string;
  operatorChanged: boolean;
  compromisedAt?: string;
  credentials: Credential[];
  reviews: Review[];
  reviewsExcluded: number;
  penaltiesConfirmed: number;
  updatedAt: string;
  snapshotUrl?: string;
  /** See AgentListResponse.scoresStale. */
  scoresStale: boolean;
}

export interface PenaltyReport {
  clientAddress: Address;
  feedbackIndex: number;
  txId: string;
}

export interface Penalty {
  agentId: string;
  category: string;
  points: number; // current, after decay
  confirmedAt: string;
  /** When the points next halve; show as "halving in N days". */
  nextHalvingAt: string;
  reports: PenaltyReport[];
}

export interface CreatorDetail {
  address: Address;
  verifiedAt: string;
  score: number;
  tier: Tier;
  penaltyTotal: number;
  penalties: Penalty[];
  agents: AgentSummary[];
}

/** One API key a creator authorized, as the dashboard and the SDK see it. */
export interface GrantSummary {
  /** The address derived from the API key. The key itself never reaches the server. */
  grantKey: Address;
  creator: Address;
  authorizedAt: string;
  expiresAt: string;
  maxAgents: number;
  /** Agents this key has linked so far. */
  used: number;
  revoked: boolean;
  /** True once `expiresAt` has passed. */
  expired: boolean;
  agents: AgentSummary[];
}

export interface CreatorGrantsResponse {
  grants: GrantSummary[];
}

/**
 * What a client needs to talk to the deployment: the SDK reads it, so redeploying the contracts does
 * not mean publishing a new SDK.
 */
export interface ConfigResponse {
  network: 'hedera-testnet';
  chainId: number;
  identityRegistry: Address;
  /** Null until CreatorRegistry is deployed and configured on the server. */
  creatorRegistry: Address | null;
  /** The credential collection as 0.0.x, or null when not configured. */
  credentialTokenId: string | null;
  mirrorNode: string;
}

export interface AgentQuery {
  q?: string;
  /** true shows only human-backed agents. false or missing applies no filter. */
  humanBacked?: boolean;
  minScore?: number;
  /**
   * Only agents this wallet owns now. An agent it has not linked yet has `creator: null`, which is
   * how onboarding finds where to resume. Wallets that are not verified creators get no unlinked agents.
   * An agent a stranger minted and transferred to this wallet is left out until the wallet links it.
   */
  owner?: Address;
}

export interface AgentListResponse {
  /** Linked agents, plus agents minted by verified creators and not linked yet (`creator: null`). */
  agents: AgentSummary[];
  /** Global totals over every listed agent. They do not change with the query filters. */
  stats: { agents: number; humanBacked: number; creators: number; reviewsCounted: number };
  /**
   * True when the latest snapshot is 2 or more epochs old. Before the first snapshot it is false for
   * two epochs from the server's first start, then true until one is published.
   */
  scoresStale: boolean;
}

/** POST /api/rp-signature, with no body or `{}`. Start here: the nonce feeds the next two steps. */
export interface RpSignatureResponse {
  /** Pass straight to IDKit as `rp_context`. */
  rp_context: {
    rp_id: string;
    nonce: string;
    created_at: number;
    expires_at: number;
    signature: string;
  };
  action: string;
  environment: 'production' | 'staging' | 'sandbox';
  /** The only protocol version POST /api/verify accepts. */
  protocol_version: '3.0' | '4.0';
}

/** POST /api/verify. Pass the wallet to IDKit as its 0x-prefixed signal. */
export interface VerifyRequest {
  wallet: Address;
  /** EIP-191 signature by `wallet` over walletBindingMessage(wallet, action, nonce). */
  walletSignature: `0x${string}`;
  /** The IDKit result, unmodified. */
  idkitResponse: unknown;
}

export interface VerifyResponse {
  transactionHash: `0x${string}`;
  /** Mirror form 0.0.x-seconds-nanos. Null if the Mirror Node has not indexed it within about 10 s. */
  transactionId: string | null;
  wallet: Address;
  nullifierHash: `0x${string}`;
}

/** POST /api/session: sign in with a wallet, once, and keep the token instead of signing again. */
export interface SessionRequest {
  wallet: Address;
  /** Unix seconds when the wallet signed. The server accepts it for 5 minutes. */
  issuedAt: number;
  /** EIP-191 signature by `wallet` over sessionMessage(wallet, issuedAt). */
  signature: `0x${string}`;
}

/** The token goes in an `Authorization: Bearer` header. It proves control of `wallet`, not creator status. */
export interface SessionResponse {
  token: string;
  wallet: Address;
  /** Unix seconds. */
  expiresAt: number;
}

/** GET /api/session: the token is still good. */
export interface SessionInfo {
  wallet: Address;
  expiresAt: number;
}

/** POST /api/agent-file: an ERC-8004 registration file. Extra fields are kept in the file. */
export interface AgentFileRequest {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1';
  name: string;
  description: string; // may be empty
  image: string; // may be empty
  services: { name: string; endpoint: string; version?: string }[]; // at least one
  x402Support: boolean;
  active: boolean;
  registrations: { agentId: string | number; agentRegistry: string }[]; // may be empty
  supportedTrust?: string[];
  [extra: string]: unknown;
}

export interface AgentFileResponse {
  uri: string;
  hash: `0x${string}`;
}

/** Serialised by serializeReviewFile, and must stay under 1,024 bytes. */
export interface ReviewFile {
  agentRegistry: string; // CAIP-10: eip155:296:0x...
  agentId: string | number;
  clientAddress: string; // CAIP-10: eip155:296:0x...
  createdAt: string; // ISO 8601
  value: number; // whole number, 0-100
  valueDecimals: 0;
  tag1: 'quality' | 'misconduct';
  tag2: string; // ^[a-z0-9-]{1,32}$
  endpoint: string;
  comment?: string;
  proofOfPayment?: string;
}

/** POST /api/review-file. Unknown fields are rejected. */
export interface ReviewFileRequest extends ReviewFile {
  /** EIP-191 signature by clientAddress over serializeReviewFile(file). Never published. */
  signature: `0x${string}`;
}

export interface ReviewFileResponse {
  feedbackUri: string;
  feedbackHash: `0x${string}`;
}

/** The reviews that went one way between an agent and one peer. */
export interface InteractionStats {
  reviews: number;
  counted: number;
  /** Average review value, 0-100. Null when there are none. */
  average: number | null;
  lastValue: number | null;
  /** ISO 8601. */
  lastAt: string | null;
}

/** Someone an agent reviewed or was reviewed by. Each review stands for a paid job between them. */
export interface InteractionPeer {
  /** The account that sent the reviews, or the reviewed agent's owner. */
  address: Address;
  /** The peer agent, when the address owns exactly one agent. */
  agent: AgentSummary | null;
  /** How many agents this address owns. Above one, the reviews cannot be pinned to one of them. */
  agentCount: number;
  /** Reviews this agent gave the peer. */
  given: InteractionStats;
  /** Reviews the peer gave this agent. */
  received: InteractionStats;
  /** ISO 8601, the latest review either way. */
  lastAt: string;
}

/** GET /api/agents/:agentId/interactions. Peers newest first. */
export interface AgentInteractions {
  agentId: string;
  peers: InteractionPeer[];
  updatedAt: string;
}

/** GET /api/events (Server-Sent Events), `event: scores`: the live view changed. */
export interface ScoresEvent {
  /** Changes whenever a score, a review count or the set of reviews changes. */
  version: string;
  /** ISO 8601 consensus time of the view. */
  asOf: string;
  /** Agents whose score, counted reviews or penalties changed since the previous event. */
  changed: string[];
}
