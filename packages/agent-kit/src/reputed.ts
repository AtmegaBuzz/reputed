import type { Client } from '@hiero-ledger/sdk';
import type { Plugin } from '@hashgraph/hedera-agent-kit';
import { InvalidApiKeyError, parseApiKey, type AgentDetail, type ApiError, type ConfigResponse } from '@reputed/shared';
import { ReputedClient, type VerifyOptions, type VerifyResult } from '@reputed/sdk';
import type { Address } from 'viem';
import type { AgentContext } from './context';
import { ReputedAgentError } from './errors';
import { clientGateway } from './gateway';
import { MirrorClient } from './mirror';
import { onboard, type AgentProfile, type OnboardResult } from './onboard';
import { pay, verifyPayment, type PaymentCheck, type PaymentReceipt, type PayOptions, type VerifyPaymentOptions } from './payments';
import { createReputedPlugin } from './plugin';
import { review, waitForReview, type ReviewInput, type ReviewOutcome, type ReviewReceipt, type WaitForReviewOptions } from './review';
import { FileStateStore, MemoryStateStore, type StateStore } from './state';

// The public entry point. `connect` validates the inputs that need no network, fetches the deployment
// from /api/config (contract addresses and the Mirror Node URL are not baked into the package), runs
// onboarding, and returns an object that holds the agent ID, a read client, and what paying and
// reviewing need (the Client's gateway and a Mirror Node client). The API key is used inside
// onboarding to sign and is not kept.

export interface ReputedConnectOptions {
  /** The agent's Hedera client. Its operator account becomes the agent's on-chain identity. */
  client: Client;
  /** From the Reputed dashboard: rpk_test_… */
  apiKey: string;
  /** What the agent is and how to reach it. Used only the first time, to register it. */
  agent: AgentProfile;
  /** The Reputed API. Defaults to the REPUTED_API_URL environment variable. */
  apiUrl?: string;
  /** Link an agent you already registered instead of registering a new one. */
  agentId?: string | number | bigint;
  /**
   * Where progress is written so an interrupted run carries on instead of starting over.
   * A file path (default `.reputed/state.json`), `false` to keep it in memory, or your own store.
   */
  state?: string | false | StateStore;
  /** Progress messages while onboarding. Silent by default. */
  logger?: (message: string) => void;
  fetch?: typeof fetch;
}

export const DEFAULT_STATE_FILE = '.reputed/state.json';

/** The two Reputed API calls onboarding makes (config, agent file). Error messages name the origin, never the body sent. */
async function apiJson<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (cause) {
    throw new ReputedAgentError('API_ERROR', `Could not reach the Reputed API at ${new URL(url).origin}.`, { cause });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ReputedAgentError('API_ERROR', body?.message ?? `The Reputed API answered ${res.status}.`);
  }
  return (await res.json()) as T;
}

/** An agent with a Reputed identity. Create one with `Reputed.connect`. */
export class Reputed {
  /** Add this to the Hedera Agent Kit's `configuration.plugins`. */
  readonly plugin: Plugin;

  readonly #actions: AgentContext;

  private constructor(
    readonly client: ReputedClient,
    readonly onboarding: OnboardResult,
    actions: Omit<AgentContext, 'agentId' | 'owner' | 'creator' | 'api'>,
  ) {
    this.plugin = createReputedPlugin(this);
    this.#actions = { ...actions, agentId: onboarding.agentId, owner: onboarding.owner, creator: onboarding.creator, api: client };
  }

  get agentId(): string {
    return this.onboarding.agentId;
  }
  /** The verified human behind the API key. */
  get creator(): Address {
    return this.onboarding.creator;
  }
  /** The agent account's EVM address. */
  get owner(): Address {
    return this.onboarding.owner;
  }

  /**
   * Registers the agent, links it to its human and receives its credential, the first time. Every
   * later call finds all of that in place and only looks it up. Safe to run again after a crash.
   */
  static async connect(options: ReputedConnectOptions): Promise<Reputed> {
    const apiUrl = (options.apiUrl ?? process.env['REPUTED_API_URL'])?.replace(/\/+$/, '');
    if (!apiUrl) {
      throw new ReputedAgentError('NOT_CONFIGURED', 'Pass apiUrl or set REPUTED_API_URL to the address of the Reputed API.');
    }
    // Checked before any request; the error message never contains the key.
    try {
      parseApiKey(options.apiKey);
    } catch (error) {
      if (error instanceof InvalidApiKeyError) throw new ReputedAgentError('INVALID_API_KEY', error.message);
      throw error;
    }
    const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

    const config = await apiJson<ConfigResponse>(fetchImpl, `${apiUrl}/api/config`, { headers: { accept: 'application/json' } });
    const state: StateStore =
      options.state === false
        ? new MemoryStateStore()
        : typeof options.state === 'object'
          ? options.state
          : new FileStateStore(options.state ?? DEFAULT_STATE_FILE);

    const gateway = clientGateway(options.client);
    const mirror = new MirrorClient({ baseUrl: config.mirrorNode, fetch: fetchImpl });
    const now = () => Date.now();
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const result = await onboard({
      gateway,
      mirror,
      config,
      apiKey: options.apiKey,
      profile: options.agent,
      ...(options.agentId !== undefined ? { agentId: String(options.agentId) } : {}),
      state,
      postAgentFile: (file) =>
        apiJson(fetchImpl, `${apiUrl}/api/agent-file`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(file),
        }),
      now,
      sleep,
      log: options.logger ?? (() => {}),
    });

    return new Reputed(new ReputedClient({ apiUrl, fetch: fetchImpl }), result, {
      gateway,
      mirror,
      config,
      postJson: <T>(path: string, body: unknown) =>
        apiJson<T>(fetchImpl, `${apiUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }),
      now,
      sleep,
    });
  }

  /** This agent's current score, tier, credentials and reviews. */
  reputation(): Promise<AgentDetail> {
    return this.client.getAgent(this.agentId);
  }

  /** Check another agent before paying or hiring it. */
  verifyCounterparty(agentId: string | number | bigint, options?: VerifyOptions): Promise<VerifyResult> {
    return this.client.verifyCounterparty(agentId, options);
  }

  /**
   * Pays another agent in HBAR from this agent's account, to the wallet that agent registered, and
   * waits until the Mirror Node shows it. The receipt's `transactionId` is the proof a review cites.
   * It does not vet the agent: call `verifyCounterparty` first.
   */
  pay(agentId: string | number | bigint, hbar: number, options?: PayOptions): Promise<PaymentReceipt> {
    return pay(this.#actions, agentId, hbar, options);
  }

  /**
   * Checks that `from` paid this agent's registered wallet in a transaction (with `memo`, if given),
   * before delivering work for it. Returns
   * `{ ok: false, reason }` for a payment that does not qualify; throws only if the Mirror Node is down.
   */
  verifyPayment(transactionId: string, options: VerifyPaymentOptions): Promise<PaymentCheck> {
    return verifyPayment(this.#actions, transactionId, options);
  }

  /**
   * Reviews another agent: signs the review file with this agent's key, has the server publish it to
   * HCS, and sends giveFeedback from this agent's account. Refuses, before spending anything, a review
   * of your own agent, of an agent backed by the same human, or one citing a payment that did not pay
   * that agent. Each call is a new review, and each payment counts for one.
   */
  review(agentId: string | number | bigint, input: ReviewInput): Promise<ReviewReceipt> {
    return review(this.#actions, agentId, input);
  }

  /** Waits until the server has scored a review from `review()`, and returns it with the agent's new score. */
  waitForReview(receipt: Pick<ReviewReceipt, 'agentId' | 'feedbackIndex'>, options?: WaitForReviewOptions): Promise<ReviewOutcome> {
    return waitForReview(this.#actions, receipt, options);
  }
}
