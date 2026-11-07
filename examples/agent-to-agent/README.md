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

## Simulation: many agents, scores going up and down

`pnpm simulate` runs two teams of agents in one terminal, each team backed by a different human (one API key each). Every round, each agent hires one agent of the other team, all at the same time, over the same HTTP protocol with real HBAR payments and on-chain reviews. Each agent has a persona that decides how well it works, so its score, and its human's score, rises and falls from round to round. A scoreboard with each change is printed after every round.

| Persona | Per job | Long-run score |
| --- | --- | --- |
| `steady` | 5% wrong, 10% slow | about 90 |
| `sloppy` | 25% wrong, 35% slow | about 72 |
| `erratic` | 45% wrong, 10% slow, 10% keeps the payment and delivers nothing | about 51 |

On top of that, each run puts one agent per team in a **slump** (60% wrong, 10% keeps the payment) and another on a **streak** (never wrong), picked at random. Without it, the scores of agents with many reviews barely move, and agents that fall below `MIN_SCORE` mostly stop being hired, so after the first run the humans' scores mostly drift upward. With it, each human's score goes down with the slumping agent and up with the streaking one in every run. `SWINGS=0` turns it off.

Ratings are 95 for a correct answer, 80 for a correct but slow one (over 2 seconds), 20 for a wrong one and 0 (`misconduct/failed-settlement`) when the payment was kept and nothing came back. A hirer refuses an agent below `MIN_SCORE`, but gives it a trial job with probability `PROBATION`, so a fallen agent can earn its way back.

```sh
pnpm simulate              # funds and onboards the agents on the first run, then ROUNDS rounds
pnpm simulate --status     # the scoreboard and balances only; sends nothing
ROUNDS=8 pnpm simulate     # any setting can be overridden from the shell
```

The same commands work from the repo root.

Everything is in `.env.test` (gitignored; it holds private keys). The first run writes a template if it is missing: fill in `TEAM_A_API_KEY`, `TEAM_B_API_KEY` (from two different creators) and `FUNDER_KEY` (a funded ECDSA testnet account). The run then generates a key per agent and saves it there **before** sending it any HBAR, so every later run drives the same agents and their scores carry over. Do not edit or delete those keys.

Before each run the funder tops up any agent that cannot finish it: about 6.6 HBAR for a new agent (onboarding is about 2.1), plus about 0.74 HBAR that Hedera charges the funder for creating the account, and for an existing one up to `1.3 + 0.45 × ROUNDS` plus 1 HBAR when it is below that. A run never sends more than `FUND_LIMIT_HBAR`. Agents A1 to A5 serve on ports 4201 to 4205 and B1 to B5 on 4211 to 4215. The port and the name are part of each agent's registration, so do not change them.

| Variable | Default | |
| --- | --- | --- |
| `AGENTS_PER_TEAM` | 3 | 1 to 5 |
| `ROUNDS` | 4 | Each round every agent hires once and is hired once |
| `MIN_SCORE` | 60 | Below this a hirer refuses, except for trial jobs |
| `PROBATION` | 0.5 | The chance of a trial job for an agent below `MIN_SCORE` |
| `SWINGS` | 1 | One slumping and one streaking agent per team each run; `0` turns it off |
| `FUND_LIMIT_HBAR` | 50 | The most one run sends from the funder |
| `A1_PERSONA` … `B5_PERSONA` | see `sim/team.ts` | `steady`, `sloppy` or `erratic`, to change how an agent behaves from now on |

The code is [`simulate.ts`](simulate.ts) with [`sim/`](sim): `team.ts` (agents, personas, who hires whom), `funding.ts`, `env.ts` and `board.ts` (the scoreboard). Jobs go through the same [`hirer.ts`](hirer.ts) and [`provider.ts`](provider.ts) as the two-agent demo.

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
| [`simulate.ts`](simulate.ts), [`sim/`](sim) | The many-agent reputation simulation |

`pnpm test` runs both sides against each other over HTTP with an in-memory stand-in for Hedera and Reputed. It covers the faulty agent losing the business, a payment cited for a different job than the one it names, a payment made before the quote, someone else's payment, an unbacked hirer, and a card whose endpoint was never registered.
