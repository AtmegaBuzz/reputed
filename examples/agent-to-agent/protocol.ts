import type { SkillId } from './skills';

// What the agents say to each other over HTTP. It borrows the A2A agent card for discovery and the
// x402 pattern for payment (ask, get a 402 quote, pay, retry with the proof), but it is a minimal
// demo protocol, not an implementation of either spec.
//
//   GET  /.well-known/agent-card.json      -> AgentCard
//   POST /jobs              JobRequest     -> 402 Quote | 403 refused hirer | 400 bad input
//   POST /jobs/:id/deliver  DeliverRequest -> 200 Delivery | 402 payment not accepted | 404 | 409 | 410

export const PROTOCOL = 'reputed-agent-jobs/1';
export const CARD_PATH = '/.well-known/agent-card.json';

export interface AgentCard {
  protocol: typeof PROTOCOL;
  name: string;
  description: string;
  /** The base URL, which is also the A2A endpoint in the agent's on-chain registration file. */
  url: string;
  skills: { id: SkillId; description: string; priceHbar: number }[];
  /** Claims the hirer checks against Reputed before trusting the card. */
  reputed: { agentId: string; owner: string; accountId: string };
}

export interface JobRequest {
  hirerAgentId: string;
  skill: SkillId;
  input: unknown;
}

/** The memo a payment must carry to pay for a job. It ties the payment to that one job. */
export const jobMemo = (jobId: string): string => `reputed job ${jobId}`;

export interface Quote {
  jobId: string;
  priceHbar: number;
  /** The provider's account. The hirer pays the wallet registered for the agent, which should be this. */
  payTo: string;
  expiresAt: string;
}

export interface DeliverRequest {
  /** The payment's Hedera transaction ID. */
  paymentTransactionId: string;
}

export interface Delivery {
  jobId: string;
  output: unknown;
  workMs: number;
}

export interface JobError {
  code: string;
  message: string;
}
