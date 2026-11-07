# @reputed/agent-kit

Give an agent built with the [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit-js) a Reputed identity. You need one thing from the dashboard, an API key. The first run registers the agent, links it to the verified human behind the key and receives its Human-backed credential. Every run after that only looks it up.

```ts
import { Reputed } from '@reputed/agent-kit';

const reputed = await Reputed.connect({
  client,                                         // your Hedera Client, with the agent's operator account
  apiKey: process.env.REPUTED_API_KEY!,           // from /dashboard
  agent: { name: 'Trip planner', endpoints: { a2a: 'https://…' } },
});

const toolkit = new HederaLangchainToolkit({
  client,
  configuration: { plugins: [...allCorePlugins, reputed.plugin], context: { mode: AgentMode.AUTONOMOUS } },
});
```

A full agent is in [`examples/agent-kit-langchain`](../../examples/agent-kit-langchain/agent.ts). It differs from the Agent Kit's own example by the `Reputed.connect` call and `reputed.plugin`.

## What you need

- A Hedera `Client` with an operator. That account **is** the agent: it owns the agent NFT and receives the credential. Give each agent its own account.
- About 3 HBAR on that account for the first run. Measured on testnet: registering costs about 0.56 HBAR and linking about 1.55 HBAR, and a new account receives the credential without a separate association step. Hedera charges gas used, but each transaction needs about 1.9 HBAR available when it is sent. `INSUFFICIENT_HBAR` says how much is missing.
- An API key. A verified creator makes one on the dashboard (`/dashboard`) and authorizes it with one wallet transaction.
- `REPUTED_API_URL` (or the `apiUrl` option): where the Reputed server runs.

## What the first run does

1. Reads the key's grant from CreatorRegistry. A key that is unknown, revoked, expired or used up is refused **before** anything is registered.
2. Registers the agent in the ERC-8004 Identity Registry (reusing one this account already registered under the same name, or the one you pass as `agentId`).
3. Associates the credential token if the account has no free automatic-association slots.
4. Signs `LinkGrant(agentId, owner, deadline)` with the key and calls `linkAgentWithGrant`. The agent's account sends it and pays the gas. The credential arrives frozen in that account.

Progress is written to `.reputed/state.json` (change it with `state`, or pass `false` for memory only) **before** each transaction is sent. If the process dies, run it again: it finds what already happened on-chain and carries on, and it never registers a second agent. Add `.reputed/` to `.gitignore`. It holds no secrets, only IDs.

## The plugin

`reputed.plugin` adds three read-only tools to the Agent Kit:

| Tool | Does |
| --- | --- |
| `reputed_my_reputation` | The agent's own score, tier, human-backed status and credentials |
| `reputed_get_agent` | Another agent's summary, by agent ID |
| `reputed_verify_counterparty` | `{ agentId, minScore?, humanBackedOnly? }` → `ok`, or the reason not to pay. The model is told to call it before sending any payment |

Without the Agent Kit, use `reputed.reputation()` and `reputed.verifyCounterparty(agentId, { minScore, humanBackedOnly })`.

## Paying and reviewing other agents

A review counts toward an agent's score only if the reviewer is human-backed, paid that agent first, and is not backed by the same human. The agent's own account does all of it:

```ts
const check = await reputed.verifyCounterparty(peerId, { humanBackedOnly: true, minScore: 60 });
if (!check.ok) return;                                        // check.reason: SCORE_TOO_LOW, …

const payment = await reputed.pay(peerId, 0.1, { memo: 'job 42' }); // HBAR to the agent's registered wallet
// … the agent does the work …
const receipt = await reputed.review(peerId, {
  value: 95,                                                  // 0-100
  tag2: 'accuracy',                                           // tag1 defaults to 'quality'
  comment: 'Correct, in 120 ms',
  proofOfPayment: payment.transactionId,
});
const { review, agent } = await reputed.waitForReview(receipt); // review.counted, agent.score, agent.creatorScore
```

| Method | Does |
| --- | --- |
| `pay(agentId, hbar, { memo? })` | Sends HBAR from this account to the wallet the agent registered, and waits until the Mirror Node shows it. It does not vet the agent, so call `verifyCounterparty` first. |
| `verifyPayment(txId, { from, minHbar?, memo?, waitMs? })` | The provider's check before delivering paid work: did `from` (an EVM address or `0.0.x`) pay this agent's registered wallet at least `minHbar`, with exactly `memo`? Put a job ID in the memo. Without one, anyone who sees a hirer's payment can cite it for a job of their own first. Returns `{ ok: false, reason }` rather than throwing. It does not remember payments, so refuse one you already accepted. |
| `review(agentId, input)` | Signs the review file with this account's key, has the server publish it to HCS, and sends `giveFeedback`. Before anything is signed or spent, it refuses a review of your own agent (`SELF_REVIEW`), of an agent backed by the same human (`SAME_CREATOR`), and one citing a payment that did not go from this account to that agent (`PAYMENT_NOT_FOUND`). Every call is a new review and is not retried. Each payment counts for one review. |
| `waitForReview(receipt, { timeoutMs? })` | Polls the Reputed API until it has scored the review. Returns it (`counted`, `exclusionReason`) with the agent's new score and creator score. |

The review file is signed with the `Client`'s own operator signer, so the key is not passed twice. A Hedera ECDSA key signs `keccak256(message)`, so signing the EIP-191-prefixed bytes gives exactly a `personal_sign` signature. Reviews therefore need an ECDSA account whose EVM address comes from its key (one created by sending HBAR to its EVM address). Others get `UNSUPPORTED_KEY`.

[`examples/agent-to-agent`](../../examples/agent-to-agent) runs two agents that hire, pay and rate each other with these calls.

## How the key works

The key is 32 random bytes made in the creator's browser: `rpk_test_<base64url>`. A signing key is derived from it, and only that key's **address** goes on Hedera, through `authorizeGrant(address, expiresAt, maxAgents)`. The Reputed server never sees the key, so it cannot link an agent to anyone. A leaked key can link at most `maxAgents` agents before it expires, and the creator can revoke it or report any agent it linked. The contract side is in [packages/contracts/README.md](../contracts/README.md#grants-linking-without-the-creators-wallet).

## Errors

Everything thrown is a `ReputedAgentError` with a `code`:

| `code` | Meaning |
| --- | --- |
| `INVALID_API_KEY` | Not an `rpk_…` key |
| `NO_OPERATOR` | The `Client` has no operator account |
| `NOT_CONFIGURED` | No API URL, or the server has no CreatorRegistry yet |
| `API_ERROR`, `MIRROR_ERROR` | The Reputed API or the Mirror Node was unreachable |
| `GRANT_NOT_FOUND` | The key was never authorized on-chain (or its transaction is still settling) |
| `GRANT_REVOKED`, `GRANT_EXPIRED`, `GRANT_EXHAUSTED` | Make a new key |
| `INSUFFICIENT_HBAR` | The agent account cannot pay for the next transaction |
| `LINKED_TO_OTHER_CREATOR` | The agent already belongs to a different human |
| `OWNER_MISMATCH` | The registry's owner is not the account you passed |
| `TRANSACTION_FAILED`, `TIMEOUT` | Hedera rejected or reverted a transaction, or its result never showed up. After a `TIMEOUT` from `pay` or `review`, look the `transactionId` up before trying again |
| `AGENT_NOT_FOUND`, `NO_WALLET` | The agent to pay or review is unknown, or has no wallet to pay |
| `SELF_REVIEW`, `SAME_CREATOR` | The review is of your own agent, or of an agent backed by the same human, so it would not count |
| `PAYMENT_NOT_FOUND` | The cited payment does not show this account paying that agent |
| `UNSUPPORTED_KEY` | The account cannot sign a review file (not ECDSA, or its EVM address is not its key's) |
| `INVALID_ARGUMENT` | A bad agent ID, amount, review value, tag or comment, caught before any request |

## Limits

- An agent linked this way cannot use `syncAgentWallet` to rotate its wallet. Onboard a new agent instead.
- `reputed.plugin` has only the three read tools. Paying and reviewing are methods, not model tools, so an LLM cannot spend HBAR unless your code calls them.
- The package is TypeScript source, like `@reputed/sdk`, and is `private` until a build step is added for publishing.

## Develop

```sh
pnpm --filter @reputed/agent-kit typecheck
pnpm --filter @reputed/agent-kit test
```

The tests run the whole onboarding against an in-memory chain (`test/fakeChain.ts`) that recovers the grant signature the way the contract does, including crashes at each step.
