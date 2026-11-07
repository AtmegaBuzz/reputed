# Reputed — Human-Backed Agent Reputation on Hedera

Reputed ties every AI agent's reputation to a unique, World ID–verified human. Agents register in the ERC-8004 registries on Hedera, reviews live in the ERC-8004 Reputation Registry, and proven misconduct by an agent lowers its creator's score too. A creator cannot escape a bad score by starting over with a new wallet, because World ID allows one creator record per human.

## Docs

| Doc | What it covers |
| --- | --- |
| [4-Hour MVP Plan](docs/01-4-hour-mvp-plan.md) | What ships in 4 hours, hour-by-hour plan across 3 tracks, 15 manual tests, demo script, cut list |
| [Phased Implementation Plan](docs/02-implementation-plan.md) | The full build in 9 phases (0–8), each with tasks and manual tests; risks and open decisions |
| [Features List](docs/03-features.md) | 60 features in 8 groups, with IDs, priority (MVP / Next / Later) and phase |
| [UI Elements](docs/04-ui-elements.md) | Screen map, global elements, 6 screens, shared components and states |
| [Work Split](docs/05-work-split.md) | Who owns each phase, Swapnil's task list, and the rules for working in parallel |
| [Testnet Runbook](docs/06-testnet-runbook.md) | The ordered steps from a funded operator to a live server, and which plan tests each step unlocks |
| [Completion Plan](docs/07-completion-plan.md) | What is left, in order, with owners and exit tests |
| [Architecture Notes](docs/08-architecture-notes.md) | The design decisions that are easy to miss reading file by file, each tied to the function that implements it |

## Stack

- **Hedera testnet** (EVM chain ID 296, JSON-RPC relay `https://testnet.hashio.io/api`, Mirror Node `https://testnet.mirrornode.hedera.com`)
- **ERC-8004** Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` (0.0.7919997) and Reputation Registry `0x8004B663056A597Dffe9eCcC1965A193B7388713` (0.0.7919998), already deployed on testnet
- **World ID** for one-human-one-creator verification
- **HTS** for the non-transferable "Human-backed" credential NFT
- **HCS** for review files and score snapshots

## Repo layout

A pnpm workspace run by Turborepo (`pnpm build`, `pnpm typecheck`, `pnpm test`).

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js app: explorer, verify, review modal and the API key dashboard (agents register from the SDK, not a web form) |
| `apps/server` | Fastify server: World ID verifier, indexer, scorer and the read API |
| `packages/contracts` | `CreatorRegistry` (Foundry) and its deploy scripts |
| `packages/shared` | Types, ABIs, constants, the agent file builder and the API key helpers, used by every other package |
| `packages/sdk` | Read client, counterparty gate and MCP server |
| `packages/agent-kit` | `@reputed/agent-kit`: wrap a Hedera Agent Kit agent with one API key and it onboards itself ([README](packages/agent-kit/README.md)) |
| `examples/agent-kit-langchain` | A LangChain agent using it |
| `examples/agent-to-agent` | Two agents, backed by two humans, that hire, pay and rate each other, moving their own and their creators' scores, plus `pnpm simulate`: two teams of agents rating each other in parallel rounds ([README](examples/agent-to-agent/README.md)) |

## Run it

You need Node 22.18 or newer and pnpm 9.4 (pinned in `package.json`).

```sh
pnpm install
pnpm typecheck   # every package
pnpm test        # every package that has tests
```

### Web app (`apps/web`)

```sh
cp apps/web/.env.example apps/web/.env.local   # then set NEXT_PUBLIC_API_URL to your server (default http://localhost:4000)
pnpm --filter @reputed/web dev       # http://localhost:3000
```

Pages: `/` (home), `/explore`, `/agent/<id>`, `/creator/<address>`, `/verify` and `/dashboard` (`/onboard` redirects there). The signing flows (Verify, the API key dashboard, the review modal and report-compromised) are built but have not been run in a browser against a real World ID app; see the [Completion Plan](docs/07-completion-plan.md).

The pages read everything from the server, with no mock data, so until the server is running they show their loading state and then an error with a Retry button. Connecting a wallet needs HashPack (the browser extension, or the mobile app over WalletConnect when `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set) with an ECDSA account; the app asks it to switch to Hedera Testnet.

Only public values go in `apps/web/.env.local`: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WORLD_APP_ID` and `NEXT_PUBLIC_WORLD_ACTION`. The footer also links `NEXT_PUBLIC_CREATOR_REGISTRY`, `NEXT_PUBLIC_CREDENTIAL_TOKEN_ID`, `NEXT_PUBLIC_SCORES_TOPIC_ID` and `NEXT_PUBLIC_GITHUB_URL` when they are set.

Production build: `pnpm --filter @reputed/web build`, then `pnpm --filter @reputed/web start`.

### SDK and MCP server (`packages/sdk`)

```sh
pnpm --filter @reputed/sdk test
REPUTED_API_URL=http://localhost:4000 node packages/sdk/examples/check-agent.ts <agentId>
REPUTED_API_URL=http://localhost:4000 node packages/sdk/src/mcp.ts   # MCP server on stdio
```

Usage, the error codes and the MCP config are in [packages/sdk/README.md](packages/sdk/README.md); the read endpoints are in [packages/sdk/docs/rest-api.md](packages/sdk/docs/rest-api.md).

### Agent reputation simulation (`examples/agent-to-agent`)

Two teams of agents, backed by two different humans, hire, pay and rate each other in parallel rounds on testnet, and a scoreboard shows every score move. Needs the server running and `examples/agent-to-agent/.env.test` (two API keys and a funded key; the first run writes a template).

```sh
pnpm simulate              # from the repo root; ROUNDS rounds with the same agents every run
pnpm simulate --status     # the scoreboard and balances only; sends nothing
ROUNDS=8 pnpm simulate
```

Details in the [example's README](examples/agent-to-agent/README.md#simulation-many-agents-scores-going-up-and-down).

### Troubleshooting

- `pnpm typecheck` fails with errors in `apps/web/.next/types` after switching branches: delete `apps/web/.next` and run it again.
- `next dev` rewrites `apps/web/next-env.d.ts` and may create `apps/web/AGENTS.md`. Both are generated by Next.js; do not commit them.

## Status

In progress. Work follows the phased plan, MVP features first. See the [work split](docs/05-work-split.md).
