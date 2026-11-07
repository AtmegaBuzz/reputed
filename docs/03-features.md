# Human-Backed Agent Reputation on Hedera — Features List

Nov 6, 2026

## How to read this list

There are 60 features in 8 groups; 30 are needed for the hackathon demo (MVP).

- **ID:** group prefix plus a number, e.g. CR-2. Use it in tickets and test reports.
- **Priority:** MVP = needed for the demo; Next = right after the demo; Later = before mainnet, or nice to have.
- **Phase:** the phase in the [Phased Implementation Plan](02-implementation-plan.md) that builds the feature.

Screen-level details are in [UI Elements](04-ui-elements.md).

## Creator identity

These features make one verified human equal exactly one creator. 4 of 7 are MVP.

| ID | Feature | What it does | Priority | Phase |
| --- | --- | --- | --- | --- |
| CR-1 | Wallet connection | HashPack on Hedera testnet (chain 296), with a wrong-network check and one-click switch. Every send also checks the wallet's real chain first and switches it, since HashPack starts on mainnet (295) | MVP | 6 |
| CR-2 | World ID verification | Orb-level proof from a server-signed request, with the creator's wallet as the signal so the proof only works for that wallet, plus a wallet signature proving the creator controls it | MVP | 2 |
| CR-3 | One human, one creator | A nullifier can register one creator, and a wallet can hold one nullifier | MVP | 1–2 |
| CR-4 | On-chain creator record | `CreatorRegistered` event and an `isHumanBacked(wallet)` view | MVP | 1 |
| CR-5 | HashPack wallet | HashPack is the only supported wallet. The picker lists the HashPack extension (found through EIP-6963) and WalletConnect for HashPack mobile when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set; other extension wallets are hidden. HashPack connects as an EVM wallet on chain 296, so only ECDSA accounts work; a banner flags Ed25519 accounts and long-zero addresses | Later | 6 |
| CR-6 | Creator wallet migration | Move a creator record to a new wallet with a fresh World ID proof | Later | 8 |
| CR-7 | Unverified creator tier | Creators without World ID, allowed at a lower trust tier | Later | 5 |

## Agent onboarding

These features take a verified creator from an idea to a registered, linked, human-backed agent. 7 of 12 are MVP.

| ID | Feature | What it does | Priority | Phase |
| --- | --- | --- | --- | --- |
| AG-1 | Agent file builder | Turns a form into the ERC-8004 registration JSON: name, description, A2A/MCP endpoints, x402 support, `supportedTrust` | MVP | 3, 6 |
| AG-2 | Agent file hosting | Validates the file and returns it as a base64 `data:` URI, with its keccak-256 hash. IPFS and HCS-1 hosting are not built | MVP | 3 |
| AG-3 | ERC-8004 registration | Calls `register(agentURI)` on the Identity Registry and reads the new agent ID | MVP | 3 |
| AG-4 | Token association helper | One click associates the agent wallet with the credential token, for a wallet with no free auto-association slots. Other wallets need no step | MVP | 3, 6 |
| AG-5 | Link agent to creator | `linkAgent(agentId)`: checks ownership; the link is permanent | MVP | 1, 3 |
| AG-6 | Human-backed credential on link | Mints the credential NFT into the agent wallet and freezes it | MVP | 1, 3 |
| AG-7 | Resume onboarding | Detects an agent that is registered but not linked, and resumes at the Link step | MVP | 6 |
| AG-8 | Separate agent wallet | `setAgentWallet` with an EIP-712 signature from the agent's own account. After linking, `syncAgentWallet` backs the new wallet and issues it a credential | Next | 3 |
| AG-9 | Edit agent file | Gets a new URI for the edited file and calls `setAgentURI` | Next | 6 |
| AG-10 | HCS-14 UAID and HCS-11 profile | Makes the agent discoverable by HCS-10 tools | Later | 3 |
| AG-11 | API keys | A verified creator makes a key in the browser on `/dashboard` and authorizes its address with `authorizeGrant` (expiry, most agents). Revoke any time. The Reputed server never sees the key | Next | 6 |
| AG-12 | Headless onboarding (`@reputed/agent-kit`) | `Reputed.connect({ client, apiKey, agent })` registers a Hedera Agent Kit agent, links it with `linkAgentWithGrant`, receives its credential and returns a plugin with reputation tools. Resumable after a crash | Next | 7 |

## Reviews and reputation

Reviews sit in the ERC-8004 Reputation Registry, where the agent being reviewed cannot refuse or delete them. 5 of 8 are MVP.

| ID | Feature | What it does | Priority | Phase |
| --- | --- | --- | --- | --- |
| RV-1 | Give feedback | A 0–100 value plus tags, sent with `giveFeedback` | MVP | 4 |
| RV-2 | Review file on HCS | Full review, comment and proof of payment on HCS, signed by the reviewer's wallet to be accepted; its hash goes on-chain | MVP | 4 |
| RV-3 | Misconduct report | `tag1 = misconduct` plus a category such as `fraud` or `failed-settlement` | MVP | 4 |
| RV-4 | Self-review block | The registry already rejects reviews from owners and operators; the UI also hides the button | MVP | 4, 6 |
| RV-5 | Payment proof check | Mirror Node lookup confirming the reviewer paid the agent wallet before reviewing. Each payment counts for one review | MVP | 5 |
| RV-6 | Revoke own review | `revokeFeedback` by the original reviewer | Next | 4 |
| RV-7 | Agent response | `appendResponse`, e.g. a refund note or a dispute. The API shows only replies from the agent's owner or wallet | Next | 4 |
| RV-8 | Full x402 payments | The official `@x402/hedera` flow as proof of payment | Later | 7 |

## Scoring and creator propagation

This is the part nobody else has: an agent's proven misconduct lowers its creator's score, and the creator cannot reset it. 7 of 10 are MVP. Formulas are in Phase 5 of the plan.

| ID | Feature | What it does | Priority | Phase |
| --- | --- | --- | --- | --- |
| SC-1 | Human-backed filter | Counts only reviews from human-backed wallets with a verified payment | MVP | 5 |
| SC-2 | Agent score | A time-decayed average from 0 to 100, weighted by each reviewer's creator score, with one vote per creator, and never above 100 minus the agent's penalties | MVP | 5 |
| SC-3 | Trust tiers | Tier 1 at 90 or above, Tier 2 at 75 or above, Tier 3 below | MVP | 5 |
| SC-4 | Misconduct penalties | Confirmed when reported by 2 different creators within 30 days: fraud costs 20 points, a failed settlement 10. One incident gives one penalty, confirming creators sit out for 180 days on that agent and category, and a confirmed penalty is final | MVP | 5 |
| SC-5 | Creator score | Average of the creator's agents, never above 100 minus penalties, so extra good agents cannot hide a bad one | MVP | 5 |
| SC-6 | Score inheritance | New agents start at their creator's current score | MVP | 5 |
| SC-7 | HCS score snapshots | Agent and creator scores published to HCS every epoch | MVP | 5 |
| SC-8 | Compromise cut-off | Penalties first reported after `reportCompromise` hit the agent but not the creator | Next | 1, 5 |
| SC-9 | Penalty decay | Penalties halve every 180 days, so creators can recover | Next | 5 |
| SC-10 | Reproducible scores | Each snapshot carries `configVersion` and `inputsHash`, so anyone can recompute it | Next | 5 |

## Credential NFTs

Credentials are the few claims an agent wants to show, held in its wallet as non-transferable HTS NFTs; individual reviews never become NFTs. 4 of 7 are MVP.

| ID | Feature | What it does | Priority | Phase |
| --- | --- | --- | --- | --- |
| CD-1 | Contract-controlled collection | One HTS NFT collection; CreatorRegistry is its treasury and holds the supply, freeze and wipe keys | MVP | 1 |
| CD-2 | Non-transferable | The holder is frozen for the token after each delivery, so the NFT cannot be sold or moved | MVP | 1 |
| CD-3 | Human-backed credential | Issued automatically when an agent is linked to its creator | MVP | 1, 3 |
| CD-4 | Revocation | The issuer wipes a serial from the holder. The job that does this automatically after a sale, rotation or compromise report is not built | MVP | 1 |
| CD-5 | Signed VC file | Metadata (100 bytes or less) points to a signed W3C Verifiable Credential JSON | Next | 1 |
| CD-6 | Milestone credentials | Issued automatically at thresholds, e.g. 100 verified paid jobs | Next | 5 |
| CD-7 | Validator credentials | "Passed audit by X", issued by named validators | Later | 8 |

## Discovery and public trust

Anyone can check an agent before hiring it, without a wallet. 2 of 5 are MVP.

| ID | Feature | What it does | Priority | Phase |
| --- | --- | --- | --- | --- |
| DS-1 | Public agent page | Score, tier, Human-backed badge, creator score, reviews and credentials; no wallet needed | MVP | 6 |
| DS-2 | HashScan links | Every on-chain item (agent NFT, review, credential, snapshot) links to HashScan | MVP | 6 |
| DS-3 | Creator profile | Creator score, penalties, all of the creator's agents, compromise reports | Next | 6 |
| DS-4 | Explorer | Search agents by name or skill; filter by human-backed and minimum score | Next | 6 |
| DS-5 | Embeddable trust badge | An image or iframe an agent's website can show, with live score and tier | Later | 7 |

## Agent SDK and API

Agents check and review each other in code, under the same rules as the web app. None of these is MVP, but SD-3 makes a strong demo moment if time allows.

| ID | Feature | What it does | Priority | Phase |
| --- | --- | --- | --- | --- |
| SD-1 | REST read API | `/api/agents` and `/api/creators`, served from the scorer's live view | Next | 6, 7 |
| SD-2 | SDK reads | `getAgent(agentId)` and `isHumanBacked(address)` | Next | 7 |
| SD-3 | Counterparty gate | `verifyCounterparty(agentId, {minScore, humanBackedOnly})`, run before paying or hiring | Next | 7 |
| SD-4 | SDK review | `review()` signs and hosts the file and calls `giveFeedback` in one call | Next | 7 |
| SD-5 | MCP server | `get_agent`, `verify_counterparty` and `review_agent` tools for LLM agents | Later | 7 |

## Operations, safety and admin

Only role separation is needed for the demo; the rest protects the system once real value depends on the scores.

| ID | Feature | What it does | Priority | Phase |
| --- | --- | --- | --- | --- |
| OP-1 | Role separation | Separate admin, verifier and issuer keys on CreatorRegistry | MVP | 1 |
| OP-2 | Report compromised agent | A creator-only contract call, plus a button on the creator profile | Next | 1, 6 |
| OP-3 | Rate limits and backoff | API rate limits by IP and wallet; Mirror Node backoff on HTTP 429 | Next | 8 |
| OP-4 | Monitoring | Error tracking on the verifier and scorer; alert if no snapshot for 2 epochs | Later | 8 |
| OP-5 | Threshold verifiers | 2-of-3 independent World ID verifiers instead of one server | Later | 8 |
| OP-6 | Mainnet deployment | Our own ERC-8004 registries on mainnet, production World ID, Orb only | Later | 8 |

## Out of scope for now

These are deliberately not being built, so nobody spends demo time on them.

- **Individual reviews as NFTs.** The agent could refuse unwanted ones. Reviews stay in the registry.
- **Token incentives, staking or slashing** for reviewers or validators
- **Cross-chain reputation sync** (e.g. mirroring scores to Base)
- **Legal identity or KYC.** World ID proves a unique human, not who they are.
- **A dispute court.** For now, disputes are agent responses (RV-7) plus the 2-creator misconduct rule.
- **On-chain score computation.** Scores are computed off-chain and published to HCS, as ERC-8004 recommends.
- **Storing personal data** of any kind
