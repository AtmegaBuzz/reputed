import {
  REPUTATION_REGISTRY,
  reputationRegistryAbi,
  serializeReviewFile,
  type AgentDetail,
  type ConfigResponse,
  type ReviewFile,
  type ReviewFileResponse,
} from '@reputed/shared';
import { ReputedError } from '@reputed/sdk';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
  getAddress,
  keccak256,
  recoverMessageAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AgentContext } from '../src/context';
import { ReputedAgentError } from '../src/errors';
import type { AgentGateway, TxOutcome } from '../src/gateway';
import type { ContractResult, MirrorAccount, MirrorTransaction } from '../src/mirror';

// An in-memory ledger for payments and reviews: accounts with balances, HBAR transfers recorded the
// way the Mirror Node reports them (fees included), the Reputation Registry's giveFeedback with its
// self-review rule and NewFeedback log, and the Reputed API's agent reads and review-file route. The
// signer is a real secp256k1 key, so signatures are checked by recovery, as the server checks them.

export const ME_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
export const ME: Address = privateKeyToAccount(ME_KEY).address;
export const ME_ACCOUNT = '0.0.6001';
export const MY_CREATOR: Address = getAddress('0x00000000000000000000000000000000000000c1');
export const PEER: Address = getAddress('0x00000000000000000000000000000000000000b2');
export const PEER_ACCOUNT = '0.0.6002';
export const PEER_CREATOR: Address = getAddress('0x00000000000000000000000000000000000000c2');
export const STRANGER_ACCOUNT = '0.0.6003';
export const REPUTATION_CONTRACT = '0.0.1003';
export const FEE_TINYBAR = 120_000;
export const IDENTITY: Address = getAddress('0x8004A818BFB912233c491871b3d84c89A494BD9e');

export const CONFIG: ConfigResponse = {
  network: 'hedera-testnet',
  chainId: 296,
  identityRegistry: IDENTITY.toLowerCase() as Address,
  creatorRegistry: getAddress('0x4444444444444444444444444444444444444444'),
  credentialTokenId: '0.0.700',
  mirrorNode: 'https://mirror.test',
};

export function agentDetail(over: Partial<AgentDetail> & Pick<AgentDetail, 'agentId' | 'owner'>): AgentDetail {
  return {
    name: `Agent ${over.agentId}`,
    description: '',
    tags: [],
    wallet: over.owner,
    creator: PEER_CREATOR,
    humanBacked: true,
    score: { value: 100, tier: 'Tier 1', isNew: true },
    creatorScore: 100,
    reviewsCounted: 0,
    registeredAt: '2026-11-07T00:00:00.000Z',
    acceptsX402: false,
    status: 'active',
    endpoints: { a2a: 'http://peer.test/a2a' },
    agentUri: 'data:application/json;base64,e30=',
    operatorChanged: false,
    credentials: [],
    reviews: [],
    reviewsExcluded: 0,
    penaltiesConfirmed: 0,
    updatedAt: '2026-11-07T00:00:00.000Z',
    scoresStale: false,
    ...over,
  };
}

export class FakeLedger implements AgentGateway {
  readonly accountId = ME_ACCOUNT;
  now = 1_800_000_000_000;
  /** Seconds part of the next transaction's consensus time. */
  private clock = 1_800_000_000;
  balances = new Map<string, bigint>([
    [ME_ACCOUNT, 10n * 100_000_000n],
    [PEER_ACCOUNT, 0n],
    [STRANGER_ACCOUNT, 10n * 100_000_000n],
  ]);
  evm = new Map<string, string>([
    [ME.toLowerCase(), ME_ACCOUNT],
    [PEER.toLowerCase(), PEER_ACCOUNT],
  ]);
  transactions = new Map<string, MirrorTransaction[]>();
  results = new Map<string, ContractResult>();
  agents = new Map<string, AgentDetail>([
    ['5', agentDetail({ agentId: '5', owner: ME, creator: MY_CREATOR })],
    ['7', agentDetail({ agentId: '7', owner: PEER })],
  ]);
  /** What POST /api/review-file received, and the bytes it published. */
  posted: { body: ReviewFile & { signature: Hex }; bytes: Uint8Array }[] = [];
  sent: { kind: 'transfer' | 'contract'; detail: unknown }[] = [];
  /** How many polls before a new transaction shows up on the Mirror Node. */
  indexLag = 1;
  private lagLeft = new Map<string, number>();
  /** Makes the server answer with a hash that is not the file's. */
  tamperHash = false;
  nextFeedbackIndex = 1;
  signer = privateKeyToAccount(ME_KEY);

  private nextTxId(): string {
    this.clock += 1;
    return `${ME_ACCOUNT}-${this.clock}-000000001`;
  }

  /** Records a transfer as the Mirror Node shows it: the payer also pays the node and fee accounts. */
  recordTransfer(id: string, from: string, to: string, tinybar: bigint, result = 'SUCCESS', memo = ''): void {
    const ts = `${id.split('-')[1]}.000000002`;
    const transfers =
      result === 'SUCCESS'
        ? [
            { account: from, amount: -Number(tinybar) - FEE_TINYBAR },
            { account: to, amount: Number(tinybar) },
            { account: '0.0.3', amount: 20_000 },
            { account: '0.0.98', amount: FEE_TINYBAR - 20_000 },
          ]
        : [{ account: from, amount: -FEE_TINYBAR }, { account: '0.0.98', amount: FEE_TINYBAR }];
    this.transactions.set(id, [{ transaction_id: id, result, consensus_timestamp: ts, memo_base64: Buffer.from(memo).toString('base64'), transfers }]);
    this.lagLeft.set(id, this.indexLag);
  }

  // AgentGateway -------------------------------------------------------------------------------

  async executeContract(contractId: string, data: Hex, gas: bigint): Promise<TxOutcome> {
    const transactionId = this.nextTxId();
    this.sent.push({ kind: 'contract', detail: { contractId, gas } });
    if (contractId !== REPUTATION_CONTRACT) throw new Error(`unexpected contract ${contractId}`);
    const { functionName, args } = decodeFunctionData({ abi: reputationRegistryAbi, data });
    if (functionName !== 'giveFeedback') throw new Error(`unexpected ${functionName}`);
    const [agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash] = args as unknown as [
      bigint, bigint, number, string, string, string, string, Hex,
    ];
    const agent = this.agents.get(agentId.toString());
    if (agent && getAddress(agent.owner) === ME) {
      // Error(string), as the registry reverts.
      const reason = encodeAbiParameters([{ type: 'string' }], ['Self-feedback not allowed']);
      this.results.set(transactionId, { result: 'CONTRACT_REVERT_EXECUTED', error_message: `0x08c379a0${reason.slice(2)}`, logs: [] });
      return { transactionId, status: 'CONTRACT_REVERT_EXECUTED' };
    }
    const event = getAbiItem({ abi: reputationRegistryAbi, name: 'NewFeedback' });
    const topics = encodeEventTopics({ abi: reputationRegistryAbi, eventName: 'NewFeedback', args: { agentId, clientAddress: ME, indexedTag1: tag1 } as never });
    const dataLog = encodeAbiParameters(
      event.inputs.filter((input) => !input.indexed),
      [BigInt(this.nextFeedbackIndex), value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash],
    );
    this.results.set(transactionId, {
      result: 'SUCCESS',
      error_message: null,
      logs: [{ address: REPUTATION_REGISTRY.toLowerCase(), topics: topics as string[], data: dataLog }],
    });
    this.nextFeedbackIndex += 1;
    return { transactionId, status: 'SUCCESS' };
  }

  async associateToken(): Promise<TxOutcome> {
    throw new Error('not used');
  }

  async transferHbar(toAccountId: string, tinybar: bigint, memo?: string): Promise<TxOutcome> {
    const transactionId = this.nextTxId();
    this.sent.push({ kind: 'transfer', detail: { toAccountId, tinybar, memo } });
    this.balances.set(ME_ACCOUNT, (this.balances.get(ME_ACCOUNT) ?? 0n) - tinybar - BigInt(FEE_TINYBAR));
    this.balances.set(toAccountId, (this.balances.get(toAccountId) ?? 0n) + tinybar);
    this.recordTransfer(transactionId, ME_ACCOUNT, toAccountId, tinybar, 'SUCCESS', memo ?? '');
    return { transactionId: transactionId.replace(/-(\d+)-(\d+)$/, '@$1.$2').replace(/\.0+(\d)$/, '.$1'), status: 'SUCCESS' };
  }

  async signMessage(message: Uint8Array): Promise<Hex> {
    return this.signer.signMessage({ message: { raw: message } });
  }

  // Mirror ---------------------------------------------------------------------------------------

  readonly mirror = {
    getAccount: async (idOrAddress: string): Promise<MirrorAccount | null> => {
      const account = idOrAddress.startsWith('0x') ? this.evm.get(idOrAddress.toLowerCase()) : idOrAddress;
      if (!account || !this.balances.has(account)) return null;
      const evm = [...this.evm.entries()].find(([, id]) => id === account)?.[0] ?? null;
      return { account, evm_address: evm, balance: { balance: Number(this.balances.get(account)) }, max_automatic_token_associations: -1 };
    },
    getContractId: async (evm: string) => (evm.toLowerCase() === REPUTATION_REGISTRY.toLowerCase() ? REPUTATION_CONTRACT : null),
    getContractResult: async (id: string) => this.results.get(id) ?? null,
    getTransaction: async (id: string) => {
      const left = this.lagLeft.get(id) ?? 0;
      if (left > 0) {
        this.lagLeft.set(id, left - 1);
        return null;
      }
      return this.transactions.get(id) ?? null;
    },
  };

  // Reputed API ----------------------------------------------------------------------------------

  readonly api = {
    getAgent: async (agentId: string | number | bigint): Promise<AgentDetail> => {
      const agent = this.agents.get(String(agentId));
      if (!agent) throw new ReputedError('AGENT_NOT_FOUND', 'No such agent.', { status: 404 });
      return structuredClone(agent);
    },
  };

  async postJson<T>(path: string, body: unknown): Promise<T> {
    if (path !== '/api/review-file') throw new ReputedAgentError('API_ERROR', `unexpected POST ${path}`);
    const { signature, ...file } = body as ReviewFile & { signature: Hex };
    const bytes = serializeReviewFile(file);
    const signer = await recoverMessageAddress({ message: { raw: bytes }, signature });
    const client = getAddress(file.clientAddress.slice(file.clientAddress.lastIndexOf(':') + 1));
    if (signer !== client) throw new ReputedAgentError('API_ERROR', 'Invalid review file: check "signature".');
    this.posted.push({ body: body as ReviewFile & { signature: Hex }, bytes });
    const response: ReviewFileResponse = {
      feedbackUri: `hcs://0.0.900/${this.posted.length}`,
      feedbackHash: this.tamperHash ? keccak256(new Uint8Array([1])) : keccak256(bytes),
    };
    return response as T;
  }

  context(): AgentContext {
    return {
      agentId: '5',
      owner: ME,
      creator: MY_CREATOR,
      gateway: this,
      mirror: this.mirror,
      api: this.api,
      config: CONFIG,
      postJson: (path, body) => this.postJson(path, body),
      now: () => this.now,
      sleep: async (ms) => {
        this.now += ms;
      },
    };
  }
}
