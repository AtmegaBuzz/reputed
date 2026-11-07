'use client';

import Link from 'next/link';
import type { AgentDetail } from '@reputed/shared';
import { IDENTITY_REGISTRY, hashscan } from '@reputed/shared';
import { EXCLUSION_TEXT } from '@/lib/exclusion';
import { formatDate, formatDateTime } from '@/lib/format';
import { fileHref } from '@/lib/uri';
import { useAgent } from '@/lib/useAgent';
import { AddressChip } from './AddressChip';
import { EmptyState } from './EmptyState';
import { HumanBackedBadge } from './HumanBackedBadge';
import { InlineError } from './InlineError';
import { InteractionGraph } from './InteractionGraph';
import { LiveNumber } from './LiveNumber';
import { MintedNfts } from './MintedNfts';
import { ReviewList } from './ReviewList';
import { ReviewSlot } from './ReviewSlot';
import { ScoreRing } from './ScoreRing';
import { StaleScoresChip } from './StaleScoresChip';
import { TierBadge } from './TierBadge';

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Hero({ agent }: { agent: AgentDetail }) {
  const image = agent.image?.startsWith('https://') ? agent.image : null;
  return (
    <header className="profile-top">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="agent-image agent-image-lg" src={image} alt="" width={96} height={96} referrerPolicy="no-referrer" />
      ) : (
        <span className="agent-image agent-image-lg agent-image-fallback" aria-hidden="true">
          {agent.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="profile-text">
        <div className="profile-meta">
          <span className="mono">Agent #{agent.agentId}</span>
          <span>Updated {formatDateTime(agent.updatedAt)}</span>
          {agent.humanBacked && <HumanBackedBadge credential={agent.credentials.find((c) => c.kind === 'human-backed' && !c.revoked)} />}
        </div>
        <h1>{agent.name}</h1>
        <p>{agent.description}</p>
        {agent.tags.length > 0 && (
          <div className="chips">
            {agent.tags.map((t) => (
              <span key={t} className="chip">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="profile-score">
        <ScoreRing value={agent.score.value} tier={agent.score.tier} isNew={agent.score.isNew} size="lg" />
        <TierBadge tier={agent.score.tier} isNew={agent.score.isNew} />
        {agent.score.isNew && <span className="agent-score-note">Score inherited from the creator</span>}
      </div>
    </header>
  );
}

function CreatorCard({ agent }: { agent: AgentDetail }) {
  return (
    <section className="card">
      <h2>Creator</h2>
      {agent.creator ? (
        <>
          <div className="row">
            <AddressChip address={agent.creator} />
            <span className="muted">
              {agent.creatorScore === null ? 'No creator score' : <>Creator score <LiveNumber value={agent.creatorScore} format={(v) => v.toFixed(2)} /></>}
            </span>
          </div>
          <Link href={`/creator/${agent.creator}`}>View creator profile</Link>
        </>
      ) : (
        <p className="muted">This agent is not linked to a creator.</p>
      )}
      <div className="row muted">
        Owner <AddressChip address={agent.owner} />
      </div>
      {agent.operatorChanged && (
        <p className="note-warn">Operator changed: the agent NFT has been transferred since it was registered.</p>
      )}
    </section>
  );
}

function TrustBreakdown({ agent }: { agent: AgentDetail }) {
  const reasons = new Map<string, number>();
  for (const r of agent.reviews) {
    if (!r.counted && r.exclusionReason) reasons.set(r.exclusionReason, (reasons.get(r.exclusionReason) ?? 0) + 1);
  }
  return (
    <dl className="profile-stats" aria-label="Trust breakdown">
      <div>
        <dt>Reviews counted</dt>
        <dd>
          <LiveNumber value={agent.reviewsCounted} />
        </dd>
      </div>
      <div>
        <dt>Reviews excluded</dt>
        <dd>
          <LiveNumber value={agent.reviewsExcluded} />
        </dd>
      </div>
      <div>
        <dt>Confirmed penalties</dt>
        <dd>
          <LiveNumber value={agent.penaltiesConfirmed} />
        </dd>
      </div>
      <div>
        <dt>Creator score</dt>
        <dd>
          <LiveNumber value={agent.creatorScore} format={(v) => v.toFixed(2)} />
        </dd>
      </div>
      {agent.reviewsExcluded > 0 && (
        <details>
          <summary>Why were reviews excluded?</summary>
          {reasons.size === 0 ? (
            <p className="muted">The reasons are not available.</p>
          ) : (
            <ul>
              {[...reasons].map(([reason, count]) => (
                <li key={reason}>
                  {count} × {capitalise(EXCLUSION_TEXT[reason as keyof typeof EXCLUSION_TEXT] ?? reason)}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
    </dl>
  );
}

function Endpoints({ agent }: { agent: AgentDetail }) {
  const { a2a, mcp, web, x402PriceHbar } = agent.endpoints;
  const items: { label: string; value: string }[] = [];
  if (a2a) items.push({ label: 'A2A', value: a2a });
  if (mcp) items.push({ label: 'MCP', value: mcp });
  if (web) items.push({ label: 'Website', value: web });
  return (
    <section className="card">
      <h2>Endpoints</h2>
      {items.length === 0 && x402PriceHbar === undefined ? (
        <p className="muted">No endpoints listed.</p>
      ) : (
        <ul className="plain-list">
          {items.map((i) => (
            <li key={i.label}>
              <span className="muted">{i.label}</span>{' '}
              {i.value.startsWith('https://') ? (
                <a href={i.value} target="_blank" rel="noreferrer">
                  {i.value}
                </a>
              ) : (
                <span className="mono">{i.value}</span>
              )}
            </li>
          ))}
          {x402PriceHbar !== undefined && (
            <li>
              <span className="muted">x402 price</span> {x402PriceHbar} HBAR
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function OnChainLinks({ agent }: { agent: AgentDetail }) {
  const links: { label: string; href: string }[] = [
    { label: `Agent NFT #${agent.agentId} (Identity Registry)`, href: hashscan.contract(IDENTITY_REGISTRY) },
  ];
  const agentFile = fileHref(agent.agentUri);
  if (agentFile) links.push({ label: 'Agent file', href: agentFile });
  const snapshot = fileHref(agent.snapshotUrl);
  if (snapshot) links.push({ label: 'Latest score snapshot', href: snapshot });
  return (
    <section className="card">
      <h2>On-chain links</h2>
      <ul className="plain-list">
        {links.map((l) => (
          <li key={l.label}>
            <a href={l.href} target="_blank" rel="noreferrer">
              {l.label}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AgentSkeleton() {
  return (
    <div aria-hidden="true" className="profile">
      <div className="profile-top">
        <span className="skeleton agent-image agent-image-lg" />
        <div className="agent-hero-text">
          <span className="skeleton skeleton-text" style={{ width: '12em', height: '1.8em' }} />
          <span className="skeleton skeleton-text" style={{ width: '16em' }} />
          <span className="skeleton skeleton-text" />
        </div>
        <span className="skeleton skeleton-ring skeleton-ring-lg" />
      </div>
    </div>
  );
}

export function AgentView({ agentId }: { agentId: string }) {
  const { data: agent, isLoading, error, refetch } = useAgent(agentId);

  // Keep showing the agent if only a background refresh failed.
  if (error && !agent) return <InlineError message="Couldn’t load this agent. The server may be down." onRetry={() => void refetch()} />;
  if (agent === null || !/^\d+$/.test(agentId)) {
    return <EmptyState message="This agent doesn’t exist." action={{ label: 'Explore agents', href: '/explore' }} />;
  }
  if (isLoading || !agent) return <AgentSkeleton />;

  // Keyed by agent, so going from one agent to another remounts the page instead of flashing the
  // difference between two agents' scores as a change.
  return (
    <article key={agent.agentId} className="agent-page">
      {agent.scoresStale && (
        <div>
          <StaleScoresChip updatedAt={agent.updatedAt} />
        </div>
      )}
      {agent.compromisedAt && (
        <div className="banner-inline banner-danger" role="alert">
          Marked compromised on {formatDate(agent.compromisedAt)}. Treat this agent with caution.
        </div>
      )}
      {!agent.humanBacked && (
        <div className="banner-inline" role="alert">
          Not linked to a verified human. Its score is shown with that warning.
        </div>
      )}

      <section className="profile">
        <Hero agent={agent} />
        <TrustBreakdown agent={agent} />
      </section>

      <InteractionGraph agent={agent} />

      <div className="layout-2col">
        <div className="agent-page">
          <section>
            <div className="section-head">
              <h2>
                Reviews
                <span className="count">{agent.reviews.length}</span>
              </h2>
              <ReviewSlot agent={agent} />
            </div>
            <ReviewList reviews={agent.reviews} />
          </section>
          <MintedNfts agent={agent} />
        </div>

        <aside className="rail">
          <CreatorCard agent={agent} />
          <Endpoints agent={agent} />
          <OnChainLinks agent={agent} />
        </aside>
      </div>
    </article>
  );
}
