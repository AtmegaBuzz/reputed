# Two agents that hire and rate each other

Two agents run on two Hedera accounts, each backed by a different verified human. Each one sells a small paid skill and buys the other's: it checks the other agent on Reputed, pays it in HBAR, checks the answer itself, and rates it on-chain. Each rating moves the rated agent's score and the score of the human behind it (its creator). An agent that gives wrong answers loses score, and once it falls below `MIN_SCORE` the other agent stops hiring it.

| Agent | Sells | Price |
| --- | --- | --- |
| A, Factor Finder | prime factors of a number (`factor`) | 0.1 HBAR |
| B, Hash Notary | the SHA-256 digest of a text (`sha256`) | 0.1 HBAR |

Both skills can be checked by the hirer, so every rating is a measurement. Replace them in [`skills.ts`](skills.ts) with real work (an LLM call, a booking) and keep the shape: make a request, do the work, judge the result.

## What one job looks like

```
A                                   B                               Hedera / Reputed
│ verifyCounterparty(B, minScore)                                   ── Reputed API: human-backed? score ≥ 60?
│ POST /jobs ─────────────────────► verifyCounterparty(A)           ── Reputed API: is A human-backed?
│ ◄──────────── 402 quote 0.1 HBAR
│ pay(B, 0.1, memo: job ID) ────────────────────────────────────────── CryptoTransfer A → B's registered wallet
│ POST /jobs/:id/deliver {txId} ──► verifyPayment(txId, from A)     ── Mirror Node: A paid B ≥ 0.1 for this job, after the quote, once
│ ◄──────────── 200 answer
│ check the answer
│ review(B, 95, proofOfPayment) ───────────────────────────────────── review file → HCS, giveFeedback → ERC-8004
│ waitForReview ─────────────────────────────────────────────────────── Reputed scores it: B and B's creator move
```

Ratings: a correct answer gets 95 (80 if the work took over 2 seconds), a wrong one 20 (`quality/accuracy`). Taking the payment and not answering gets a 0 `misconduct/failed-settlement` report.

The payment's memo carries the job ID, and the provider checks it. Quotes are not authenticated, so without this anyone could ask for a quote in A's name and then cite A's payment for A's real job to collect the answer first.

Before trusting the other agent's card, the hirer checks it against Reputed: the agent ID must be owned by the address on the card, and that agent must have registered this exact URL as its endpoint. Anyone can serve a card claiming to be agent #7. Only #7's owner can register #7's endpoint.

## Why two humans

The scorer counts a review only if:

- the reviewer is human-backed,
- the reviewer paid the reviewed agent's wallet before the review, and
- the reviewer is **not** backed by the reviewed agent's own creator.

So the two agents need API keys from two different creators. World ID gives one person one creator record, so outside testnet that means two people. `review()` refuses a same-creator review with `SAME_CREATOR` before it spends anything.

## What the scores do

- An agent with no counted reviews shows its creator's score (marked "inherited").
- With counted reviews, its score is their weighted average, one vote per reviewing creator.
- A creator's score is the average of its reviewed agents, so B's wrong answer also lowers its human's score, and the score of every other new agent that human has.

With the defaults (`ROUNDS=3`, `MIN_SCORE=60`, `B_FAULTY_JOBS=2`):

| | Job 1 | Job 2 | Job 3 |
| --- | --- | --- | --- |
| A rates B | 95 → B is 95 | 20 → B is 57.5 | refused: B scores 57.5, below 60 |
| B rates A | 95 → A is 95 | 95 | 95 |

Both creators' scores follow their agents: creator B ends at 57.5, creator A at 95. That is what the first testnet run produced (agents #179 and #180, Nov 7, 2026). Creator B's other agent, #177, had no reviews of its own, so it dropped from 100 to 57.5 with its creator. Agent B's account went from 4.95 to 2.05 HBAR over the run: onboarding plus three reviews.

## Run it

You need the Reputed server running (`pnpm dev` at the repo root) and, per agent:

- its own Hedera testnet account with an ECDSA key and about 5 HBAR. Onboarding costs about 2.1 HBAR, each review about 0.3. Payments go back and forth, so they cost only fees.
- an API key from `/dashboard`, made by a different creator for each agent.

```sh
cp .env.example .env        # fill in A_PRIVATE_KEY, A_API_KEY, B_PRIVATE_KEY, B_API_KEY
pnpm demo                   # both agents in one terminal, then the final scores
```

Or run one agent per terminal, which is the same thing:

```sh
pnpm agent:a
pnpm agent:b
```

The first run registers each agent, links it to its creator and receives its credential. Later runs find the same agents (by account and name) and go straight to work. Progress is in `.reputed/agent-a.json` and `.reputed/agent-b.json`, which hold IDs only. Each run hires `ROUNDS` more jobs, so scores keep moving across runs.

**Testnet shortcut for API keys.** If you hold two test creators' wallet keys (the root `.env` has `TEST_CREATOR_n_KEY`, registered by the verifier without World ID), put them in `A_CREATOR_KEY` and `B_CREATOR_KEY` and run:

```sh
pnpm testnet-keys           # authorizes one key per creator and writes A_API_KEY, B_API_KEY
pnpm testnet-keys --new     # replaces them
```

It also reports each agent account's balance.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `ROUNDS` | 3 | Jobs each agent hires the other for, per run |
| `MIN_SCORE` | 60 | Below this the hirer stops hiring |
| `A_FAULTY_JOBS`, `B_FAULTY_JOBS` | `` / `2` | Served-job numbers that get a deliberately wrong answer |
| `A_PORT`, `B_PORT` | 4101 / 4102 | Part of each agent's registered endpoint (`http://localhost:<port>`). Keep them once the agents exist, or rename the agents |
| `A_ACCOUNT_ID`, `B_ACCOUNT_ID` | looked up | Needed only if the Mirror Node cannot find the account from its key |

## Files

| File | |
| --- | --- |
| [`agent.ts`](agent.ts) | One agent: connect, serve, hire, report |
| [`provider.ts`](provider.ts) | The selling side: card, quote, payment check, delivery |
| [`hirer.ts`](hirer.ts) | The buying side: discover, gate, pay, judge, review, watch the score |
| [`skills.ts`](skills.ts) | The two skills and their checkers |
| [`protocol.ts`](protocol.ts) | The HTTP messages: a minimal protocol that borrows the A2A agent card and the x402 pay-then-retry pattern. It is not an implementation of either spec |
| [`demo.ts`](demo.ts) | Runs both agents and prints the final scores |
| [`testnet-keys.ts`](testnet-keys.ts) | Testnet only: API keys from two creators' wallet keys |

`pnpm test` runs both sides against each other over HTTP with an in-memory stand-in for Hedera and Reputed. It covers the faulty agent losing the business, a payment cited for a different job than the one it names, a payment made before the quote, someone else's payment, an unbacked hirer, and a card whose endpoint was never registered.
