# Reputed — Demo Script

Nov 7, 2026. One take, about 3½ minutes, recorded on Hedera testnet against the live server. The demo ends on one line: **reputation follows the human, not the wallet.**

## Before recording

- Server on `:4000` and web on `:3000`, both reading the v2 CreatorRegistry (`0xcbd5…4dd2`).
- Brave with the HashPack extension on Hedera Testnet. Account 1 is the verified creator wallet (`0x58…46FF`, no keys, no agents yet). Account 2 is a wallet that has never verified.
- The agent's own Hedera account funded with about 5 HBAR, its key in `examples/agent-kit-langchain/.env`.
- World App on the phone, same World ID that verified account 1.
- A Terminal window at a large font, in `examples/agent-kit-langchain`.

## Scenes

| # | Time | Screen | What happens | Line to say |
| --- | --- | --- | --- | --- |
| 1 | 0:00 | Home | Headline and the "Top human-backed agents" card. | "Agents on Hedera have IDs, but their reputation is tied to a wallet. A bad actor just makes a new one. Reputed ties every agent to one verified human." |
| 2 | 0:20 | `/verify` | The creator wallet is already World ID-verified: the verified state and the three things it unlocks. | "A creator verifies once with World ID. One human, one creator record. No name, no email, just the proof." |
| 3 | 0:40 | `/dashboard` | Create key: name "Trip planner", 30 days, up to 3 agents. The key shows once; copy it. "Authorize on Hedera" → HashPack confirm. The key appears in the list with its grant. | "Agents don't fill in forms. The creator makes an API key, and one wallet transaction authorizes it on-chain. The server never sees the key." |
| 4 | 1:20 | Terminal | `pnpm exec tsx --env-file=.env demo.ts`. The agent reads the grant, registers in the ERC-8004 Identity Registry, links itself with the grant and receives its frozen credential. Then its own reputation, and a counterparty check: agent #159 refused (not human-backed), itself OK. | "One call, `Reputed.connect`. The agent registers itself, links to the human behind the key, and gets a non-transferable credential. Then it can check anyone before paying them." |
| 5 | 2:20 | `/agent/<id>` | Human-backed badge, creator link, credential on HashScan, score New · 100. | "Here's the agent: human-backed, credential frozen in its account, starting from its creator's score." |
| 6 | 2:45 | `/creator/0x58…` | Verified since, score 100, the agent listed. | "And here's the human. Reviews and misconduct reports land here too, so a bad agent costs its creator." |
| 7 | 3:00 | `/verify`, HashPack account 2 | Switch wallet, connect, sign, scan World ID. Refused: "This World ID already has a creator wallet (0x58…46FF)." | "Now the escape hatch. New wallet, same human, verify again. World ID says no. You cannot reset your reputation by starting over." |
| 8 | 3:30 | `/explore` | The list with the human-backed filter; footer links to the CreatorRegistry, credential token and scores topic on HashScan. | "Everything is on Hedera: ERC-8004 registries, an HTS credential, HCS reviews and scores. Reputation that can't be reset." |

## If something fails

- HashPack doesn't pop up: click the HashPack icon in the toolbar; the pending request is there.
- The key doesn't appear after the transaction: wait ten seconds, the indexer reads it from the Mirror Node.
- `INSUFFICIENT_HBAR` in the terminal: top up the agent account at portal.hedera.com/faucet and run the same command again; it resumes.
- World ID says the proof is invalid: the action must be `agent-creator-v1` on the app in `.env`; retry the scan.
