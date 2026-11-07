import { hashscan, IDENTITY_REGISTRY, type AgentDetail } from '@reputed/shared';
import { formatDateTime } from '@/lib/format';
import { AddressChip } from './AddressChip';
import { LockIcon } from './icons';

// Every NFT minted for this agent, newest first, laid out like the reviews: who minted it, what it is,
// when, and the transactions. The ERC-8004 identity NFT is minted when the agent registers; the
// Human-backed credential (an HTS NFT, frozen so it cannot move) when a verified human links it.

interface Mint {
  key: string;
  title: string;
  serial: string;
  collection: string;
  /** Who minted it: the registry contract, or CreatorRegistry for credentials. */
  mintedBy: string;
  heldBy: string | null;
  mintedAt: string | null;
  txId?: string;
  nftHref: string;
  status: { label: string; ok: boolean };
  chips: string[];
  about: string;
}

function mintsOf(agent: AgentDetail): Mint[] {
  const identity: Mint = {
    key: 'identity',
    title: 'Agent identity',
    serial: `#${agent.agentId}`,
    collection: 'ERC-8004 Identity Registry',
    mintedBy: IDENTITY_REGISTRY,
    heldBy: agent.owner,
    mintedAt: agent.registeredAt,
    ...(agent.registrationTxId ? { txId: agent.registrationTxId } : {}),
    nftHref: hashscan.contract(IDENTITY_REGISTRY),
    status: agent.operatorChanged ? { label: 'Transferred', ok: false } : { label: 'Held by the agent', ok: true },
    chips: ['ERC-721', 'identity'],
    about: 'Minted when the agent registered. Whoever holds it owns the agent and its endpoints; reviews and the score attach to this ID.',
  };
  const credentials: Mint[] = agent.credentials.map((credential) => ({
    key: `${credential.tokenId}-${credential.serial}`,
    title: credential.title,
    serial: `#${credential.serial}`,
    collection: credential.tokenId ? `Credential token ${credential.tokenId}` : 'Reputed credential',
    mintedBy: credential.issuer,
    heldBy: agent.wallet,
    mintedAt: credential.issuedAt,
    ...(credential.txId ? { txId: credential.txId } : {}),
    nftHref: hashscan.nft(credential.tokenId, credential.serial),
    status: credential.revoked ? { label: 'Revoked', ok: false } : { label: 'Active', ok: true },
    chips: [credential.kind === 'human-backed' ? 'human-backed' : 'milestone', 'HTS', 'non-transferable'],
    about:
      credential.kind === 'human-backed'
        ? 'Minted by CreatorRegistry when a World ID–verified human linked this agent. It is frozen in the agent’s account, so it cannot be sold or moved.'
        : 'A credential CreatorRegistry issued to this agent’s wallet.',
  }));
  return [identity, ...credentials].toSorted((a, b) => Date.parse(b.mintedAt ?? '') - Date.parse(a.mintedAt ?? ''));
}

export function MintedNfts({ agent }: { agent: AgentDetail }) {
  const mints = mintsOf(agent);
  return (
    <section>
      <div className="section-head">
        <h2>
          NFTs minted
          <span className="count">{mints.length}</span>
        </h2>
      </div>
      <div className="review-list">
        {mints.map((mint) => (
          <article key={mint.key} className={`card review-card nft-card${mint.status.ok ? '' : ' is-excluded'}`}>
            <header className="review-head">
              <div className="review-who">
                <span className="muted">Minted by</span>
                <AddressChip address={mint.mintedBy} />
              </div>
              <span className={`badge ${mint.status.ok ? 'badge-verified' : 'tier-3'}`}>{mint.status.label}</span>
            </header>

            <div className="review-value">
              <span className="review-number nft-serial">{mint.serial}</span>
              <span className="nft-title">
                <strong>{mint.title}</strong>
                <span className="muted">{mint.collection}</span>
              </span>
            </div>

            <div className="chips">
              {mint.chips.map((chip) => (
                <span key={chip} className="chip">
                  {chip === 'non-transferable' && <LockIcon />} {chip}
                </span>
              ))}
            </div>

            <p className="review-comment">{mint.about}</p>

            <footer className="review-foot">
              <span className="muted">{mint.mintedAt ? formatDateTime(mint.mintedAt) : 'Date unknown'}</span>
              {mint.heldBy && (
                <span className="row">
                  <span className="muted">Held by</span> <AddressChip address={mint.heldBy} />
                </span>
              )}
              <a href={mint.nftHref} target="_blank" rel="noreferrer">
                View NFT
              </a>
              {mint.txId && (
                <a href={hashscan.tx(mint.txId)} target="_blank" rel="noreferrer">
                  Mint transaction
                </a>
              )}
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}
