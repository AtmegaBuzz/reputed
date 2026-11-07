import { reputationRegistryAbi, serializeReviewFile } from '@reputed/shared';
import { decodeFunctionData, keccak256, recoverMessageAddress, type Hex } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { ReputedAgentError } from '../src/errors';
import { hbarToTinybar, pay, toMirrorTransactionId, verifyPayment } from '../src/payments';
import { review, waitForReview } from '../src/review';
import { agentDetail, FakeLedger, ME, MY_CREATOR, PEER, PEER_ACCOUNT, PEER_CREATOR, STRANGER_ACCOUNT } from './fakeLedger';

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReputedAgentError);
    return (error as ReputedAgentError).code;
  }
  return 'none';
}

let ledger: FakeLedger;
beforeEach(() => {
  ledger = new FakeLedger();
});

describe('hbarToTinybar and transaction IDs', () => {
  it('converts HBAR exactly and refuses what Hedera cannot represent', () => {
    expect(hbarToTinybar(0.1)).toBe(10_000_000n);
    expect(hbarToTinybar(1.23456789)).toBe(123_456_789n);
    expect(hbarToTinybar(0.00000001)).toBe(1n);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.000000001]) {
      expect(() => hbarToTinybar(bad)).toThrow(ReputedAgentError);
    }
  });

  it('gives one spelling per transaction, as the scorer does', () => {
    expect(toMirrorTransactionId('0.0.5@1700000000.5')).toBe('0.0.5-1700000000-000000005');
    expect(toMirrorTransactionId('0.0.5-1700000000-000000005')).toBe('0.0.5-1700000000-000000005');
    expect(toMirrorTransactionId(' 0.0.5@1700000000.123456789 ')).toBe('0.0.5-1700000000-123456789');
    expect(toMirrorTransactionId('0xabc')).toBeNull();
    expect(toMirrorTransactionId('0.0.5@1700000000')).toBeNull();
    // IDs the Mirror Node would answer 400 or 503 to, which would look like an outage.
    expect(toMirrorTransactionId('0.0.0-1700000000-1')).toBeNull();
    expect(toMirrorTransactionId('0.0.1-9999999999999-0')).toBeNull();
  });
});

describe('pay', () => {
  it('pays the account behind the agent wallet and waits for the Mirror Node', async () => {
    ledger.indexLag = 3;
    const receipt = await pay(ledger.context(), '7', 0.25, { memo: 'job 1' });
    expect(ledger.sent).toEqual([{ kind: 'transfer', detail: { toAccountId: PEER_ACCOUNT, tinybar: 25_000_000n, memo: 'job 1' } }]);
    expect(receipt.to).toBe(PEER_ACCOUNT);
    expect(receipt.tinybar).toBe(25_000_000n);
    // Normalized to the zero-padded Mirror form, whatever spelling the SDK used.
    expect(receipt.transactionId).toMatch(/^0\.0\.6001-\d+-000000001$/);
    expect(ledger.transactions.has(receipt.transactionId)).toBe(true);
  });

  it('refuses an agent with no wallet, an unknown agent, and itself', async () => {
    ledger.agents.set('8', agentDetail({ agentId: '8', owner: PEER, wallet: null }));
    ledger.agents.set('9', agentDetail({ agentId: '9', owner: ME, wallet: ME }));
    expect(await code(pay(ledger.context(), '8', 1))).toBe('NO_WALLET');
    expect(await code(pay(ledger.context(), '404', 1))).toBe('AGENT_NOT_FOUND');
    expect(await code(pay(ledger.context(), '9', 1))).toBe('INVALID_ARGUMENT');
    expect(ledger.sent).toEqual([]);
  });

  it('refuses before sending when the balance cannot cover amount and fee', async () => {
    ledger.balances.set(ledger.accountId, 100_000_000n);
    expect(await code(pay(ledger.context(), '7', 1))).toBe('INSUFFICIENT_HBAR');
    expect(ledger.sent).toEqual([]);
  });

  it('refuses bad amounts and long memos without any request', async () => {
    expect(await code(pay(ledger.context(), '7', -1))).toBe('INVALID_ARGUMENT');
    expect(await code(pay(ledger.context(), '7', 1, { memo: 'x'.repeat(101) }))).toBe('INVALID_ARGUMENT');
    expect(await code(pay(ledger.context(), 'seven', 1))).toBe('INVALID_ARGUMENT');
    expect(ledger.sent).toEqual([]);
  });

  it('reports a payment the Mirror Node never shows as TIMEOUT with its ID, not as a failure to retry', async () => {
    ledger.indexLag = 1_000;
    try {
      await pay(ledger.context(), '7', 0.1);
      expect.unreachable();
    } catch (error) {
      expect((error as ReputedAgentError).code).toBe('TIMEOUT');
      expect((error as ReputedAgentError).transactionId).toMatch(/^0\.0\.6001-/);
    }
  });
});

describe('verifyPayment', () => {
  // The provider's view: this ledger's account (0.0.6001) is the one being paid.
  it('accepts a payment from the named payer of at least the price', async () => {
    ledger.recordTransfer('0.0.6003-1800000100-000000001', STRANGER_ACCOUNT, ledger.accountId, 20_000_000n);
    const check = await verifyPayment(ledger.context(), '0.0.6003@1800000100.1', { from: STRANGER_ACCOUNT, minHbar: 0.2 });
    expect(check).toMatchObject({ ok: true, tinybar: 20_000_000n, transactionId: '0.0.6003-1800000100-000000001' });
  });

  it('refuses too little, the wrong payer, a failed transfer, a missing one and nonsense', async () => {
    ledger.recordTransfer('0.0.6003-1800000100-000000001', STRANGER_ACCOUNT, ledger.accountId, 20_000_000n);
    ledger.recordTransfer('0.0.6003-1800000101-000000001', STRANGER_ACCOUNT, ledger.accountId, 20_000_000n, 'INSUFFICIENT_PAYER_BALANCE');
    const ctx = ledger.context();
    expect(await verifyPayment(ctx, '0.0.6003-1800000100-000000001', { from: STRANGER_ACCOUNT, minHbar: 0.3 })).toMatchObject({ ok: false, reason: 'TOO_SMALL' });
    expect(await verifyPayment(ctx, '0.0.6003-1800000100-000000001', { from: PEER, minHbar: 0.1 })).toMatchObject({ ok: false, reason: 'WRONG_PARTIES' });
    expect(await verifyPayment(ctx, '0.0.6003-1800000101-000000001', { from: STRANGER_ACCOUNT })).toMatchObject({ ok: false, reason: 'FAILED' });
    expect(await verifyPayment(ctx, '0.0.6003-1800000999-000000001', { from: STRANGER_ACCOUNT, waitMs: 3_000 })).toMatchObject({ ok: false, reason: 'NOT_FOUND' });
    expect(await verifyPayment(ctx, 'not-a-tx', { from: STRANGER_ACCOUNT })).toMatchObject({ ok: false, reason: 'INVALID_TRANSACTION_ID' });
    expect(await verifyPayment(ctx, '0.0.6003-1800000100-000000001', { from: '0x000000000000000000000000000000000000dead' })).toMatchObject({ ok: false, reason: 'PAYER_UNKNOWN' });
  });

  it('checks the memo that ties a payment to one job', async () => {
    ledger.recordTransfer('0.0.6003-1800000400-000000001', STRANGER_ACCOUNT, ledger.accountId, 20_000_000n, 'SUCCESS', 'job abc');
    const ctx = ledger.context();
    expect(await verifyPayment(ctx, '0.0.6003-1800000400-000000001', { from: STRANGER_ACCOUNT, memo: 'job abc' })).toMatchObject({ ok: true });
    expect(await verifyPayment(ctx, '0.0.6003-1800000400-000000001', { from: STRANGER_ACCOUNT, memo: 'job xyz' })).toMatchObject({ ok: false, reason: 'WRONG_MEMO' });
  });

  it('counts payments to this agent’s registered wallet, as the scorer does, not to the operator', async () => {
    // The agent's wallet was moved to 0.0.6002's address: a payment to the operator no longer counts.
    ledger.agents.set('5', agentDetail({ agentId: '5', owner: ME, wallet: PEER, creator: MY_CREATOR }));
    ledger.recordTransfer('0.0.6003-1800000500-000000001', STRANGER_ACCOUNT, ledger.accountId, 20_000_000n);
    ledger.recordTransfer('0.0.6003-1800000501-000000001', STRANGER_ACCOUNT, PEER_ACCOUNT, 20_000_000n);
    const ctx = ledger.context();
    expect(await verifyPayment(ctx, '0.0.6003-1800000500-000000001', { from: STRANGER_ACCOUNT })).toMatchObject({ ok: false, reason: 'WRONG_PARTIES' });
    expect(await verifyPayment(ctx, '0.0.6003-1800000501-000000001', { from: STRANGER_ACCOUNT })).toMatchObject({ ok: true });
    ledger.agents.set('5', agentDetail({ agentId: '5', owner: ME, wallet: null, creator: MY_CREATOR }));
    expect(await verifyPayment(ctx, '0.0.6003-1800000501-000000001', { from: STRANGER_ACCOUNT })).toMatchObject({ ok: false, reason: 'NO_WALLET' });
  });

  it('does not take the fee payer of someone else’s transfer for the payer', async () => {
    // 0.0.6003 pays only the fee while 0.0.6002 moves the HBAR.
    ledger.transactions.set('0.0.6003-1800000200-000000001', [
      {
        transaction_id: '0.0.6003-1800000200-000000001',
        result: 'SUCCESS',
        consensus_timestamp: '1800000200.000000002',
        transfers: [
          { account: STRANGER_ACCOUNT, amount: -120_000 },
          { account: PEER_ACCOUNT, amount: -50_000_000 },
          { account: ledger.accountId, amount: 50_000_000 },
          { account: '0.0.98', amount: 120_000 },
        ],
      },
    ]);
    expect(await verifyPayment(ledger.context(), '0.0.6003-1800000200-000000001', { from: STRANGER_ACCOUNT })).toMatchObject({ ok: false, reason: 'WRONG_PARTIES' });
  });
});

describe('review', () => {
  it('signs the exact published bytes, posts them, and sends giveFeedback citing them', async () => {
    const paid = await pay(ledger.context(), '7', 0.1);
    const receipt = await review(ledger.context(), '7', { value: 92, tag2: 'accuracy', comment: '  Correct and fast  ', proofOfPayment: paid.transactionId });

    expect(ledger.posted).toHaveLength(1);
    const { body, bytes } = ledger.posted[0]!;
    expect(body).toMatchObject({
      agentRegistry: 'eip155:296:0x8004A818BFB912233c491871b3d84c89A494BD9e',
      agentId: '7',
      clientAddress: `eip155:296:${ME}`,
      value: 92,
      valueDecimals: 0,
      tag1: 'quality',
      tag2: 'accuracy',
      endpoint: 'http://peer.test/a2a',
      comment: 'Correct and fast',
      proofOfPayment: paid.transactionId,
    });
    const { signature, ...file } = body;
    expect(Buffer.compare(Buffer.from(serializeReviewFile(file)), Buffer.from(bytes))).toBe(0);
    expect(await recoverMessageAddress({ message: { raw: bytes }, signature })).toBe(ME);

    const sendGas = (ledger.sent[1]!.detail as { gas: bigint }).gas;
    expect(sendGas).toBe(800_000n);
    const txData = [...ledger.results.entries()].find(([id]) => id === receipt.transactionId);
    expect(txData?.[1].result).toBe('SUCCESS');
    expect(receipt).toMatchObject({ agentId: '7', feedbackIndex: 1, feedbackUri: 'hcs://0.0.900/1', feedbackHash: keccak256(bytes), value: 92 });
  });

  it('encodes giveFeedback with the URI and hash the server returned', async () => {
    let calldata: Hex | null = null;
    const original = ledger.executeContract.bind(ledger);
    ledger.executeContract = async (contractId, data, gas) => {
      calldata = data;
      return original(contractId, data, gas);
    };
    await review(ledger.context(), '7', { value: 0, tag1: 'misconduct', tag2: 'failed-settlement', endpoint: 'http://peer.test/jobs' });
    const { args } = decodeFunctionData({ abi: reputationRegistryAbi, data: calldata! });
    expect(args).toEqual([7n, 0n, 0, 'misconduct', 'failed-settlement', 'http://peer.test/jobs', 'hcs://0.0.900/1', keccak256(ledger.posted[0]!.bytes)]);
  });

  it('refuses reviews that cannot count before signing or spending anything', async () => {
    ledger.agents.set('8', agentDetail({ agentId: '8', owner: ME, wallet: ME }));
    ledger.agents.set('9', agentDetail({ agentId: '9', owner: PEER, creator: MY_CREATOR }));
    const ctx = ledger.context();
    expect(await code(review(ctx, '8', { value: 90, tag2: 'accuracy' }))).toBe('SELF_REVIEW');
    expect(await code(review(ctx, '9', { value: 90, tag2: 'accuracy' }))).toBe('SAME_CREATOR');
    expect(await code(review(ctx, '404', { value: 90, tag2: 'accuracy' }))).toBe('AGENT_NOT_FOUND');
    expect(ledger.posted).toEqual([]);
    expect(ledger.sent).toEqual([]);
  });

  it('refuses a cited payment that did not pay this agent', async () => {
    // A real payment, but from a stranger, and one to another agent.
    ledger.recordTransfer('0.0.6003-1800000300-000000001', STRANGER_ACCOUNT, PEER_ACCOUNT, 10_000_000n);
    ledger.agents.set('10', agentDetail({ agentId: '10', owner: PEER, creator: PEER_CREATOR }));
    expect(await code(review(ledger.context(), '7', { value: 90, tag2: 'accuracy', proofOfPayment: '0.0.6003-1800000300-000000001' }))).toBe('PAYMENT_NOT_FOUND');
    expect(await code(review(ledger.context(), '7', { value: 90, tag2: 'accuracy', proofOfPayment: 'made-up' }))).toBe('PAYMENT_NOT_FOUND');
    expect(ledger.posted).toEqual([]);
  });

  it('validates the input without any request', async () => {
    const ctx = ledger.context();
    for (const input of [
      { value: 101, tag2: 'accuracy' },
      { value: 50.5, tag2: 'accuracy' },
      { value: -1, tag2: 'accuracy' },
      { value: 50, tag2: 'Accuracy!' },
      { value: 50, tag2: 'accuracy', comment: 'x'.repeat(513) },
      { value: 50, tag2: 'accuracy', tag1: 'praise' as never },
    ]) {
      expect(await code(review(ctx, '7', input))).toBe('INVALID_ARGUMENT');
    }
    expect(ledger.posted).toEqual([]);
  });

  it('stops when the server’s hash is not the hash of the signed file', async () => {
    ledger.tamperHash = true;
    expect(await code(review(ledger.context(), '7', { value: 80, tag2: 'speed' }))).toBe('API_ERROR');
    expect(ledger.sent).toEqual([]);
  });

  it('refuses a signer whose address is not the account’s', async () => {
    ledger.signer = (await import('viem/accounts')).privateKeyToAccount(`0x${'11'.repeat(32)}`);
    expect(await code(review(ledger.context(), '7', { value: 80, tag2: 'speed' }))).toBe('UNSUPPORTED_KEY');
  });

  it('maps the registry’s self-feedback revert to SELF_REVIEW', async () => {
    // The API is behind the chain: it still shows the old owner, but the registry knows better.
    const ctx = ledger.context();
    ledger.agents.set('11', agentDetail({ agentId: '11', owner: PEER }));
    const original = ledger.api.getAgent;
    ledger.api.getAgent = async (id) => {
      const agent = await original(id);
      ledger.agents.set('11', agentDetail({ agentId: '11', owner: ME }));
      return agent;
    };
    try {
      await review(ctx, '11', { value: 80, tag2: 'speed' });
      expect.unreachable();
    } catch (error) {
      expect((error as ReputedAgentError).code).toBe('SELF_REVIEW');
      expect((error as ReputedAgentError).transactionId).toBeDefined();
    }
  });

  it('refuses before posting when the account cannot cover the gas', async () => {
    ledger.balances.set(ledger.accountId, 50_000_000n);
    expect(await code(review(ledger.context(), '7', { value: 80, tag2: 'speed' }))).toBe('INSUFFICIENT_HBAR');
    expect(ledger.posted).toEqual([]);
  });
});

describe('waitForReview', () => {
  it('polls until the server lists the review, then returns it with the new score', async () => {
    let polls = 0;
    const original = ledger.api.getAgent;
    ledger.api.getAgent = async (id) => {
      polls += 1;
      const agent = await original(id);
      if (polls < 3) return agent;
      return {
        ...agent,
        score: { value: 92, tier: 'Tier 1', isNew: false },
        creatorScore: 92,
        reviews: [
          {
            clientAddress: ME.toLowerCase() as `0x${string}`,
            feedbackIndex: 1,
            value: 92,
            tag1: 'quality',
            tag2: 'accuracy',
            endpoint: 'http://peer.test/a2a',
            createdAt: '2026-11-07T00:00:00.000Z',
            paymentVerified: true,
            counted: true,
            reviewerHumanBacked: true,
            feedbackUri: 'hcs://0.0.900/1',
            txId: '1800000000.000000001',
          },
        ],
      };
    };
    const { review: found, agent } = await waitForReview(ledger.context(), { agentId: '7', feedbackIndex: 1 }, { intervalMs: 1_000 });
    expect(found.counted).toBe(true);
    expect(agent.score.value).toBe(92);
    expect(polls).toBe(3);
  });

  it('gives up with TIMEOUT', async () => {
    expect(await code(waitForReview(ledger.context(), { agentId: '7', feedbackIndex: 9 }, { timeoutMs: 10_000 }))).toBe('TIMEOUT');
  });
});
