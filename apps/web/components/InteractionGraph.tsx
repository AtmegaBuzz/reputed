'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentDetail, InteractionPeer, InteractionStats, Tier } from '@reputed/shared';
import { formatDate, shortAddress } from '@/lib/format';
import { useNow } from '@/lib/live';
import { useInteractions } from '@/lib/useInteractions';

// The agent in the middle, the agents it has dealt with around it. An arrow out is a review this agent
// gave (it hired and rated that agent); an arrow in is a review it received. Arrow color is the average
// rating that way, width the number of reviews. Peers it dealt with in the last few minutes pulse:
// with live updates on, a job in progress shows up here as soon as its review is scored.

/** A peer counts as "interacting now" this long after the last review either way. */
const ACTIVE_MS = 3 * 60_000;

const TIER_CLASS: Record<Tier, string> = { 'Tier 1': 'tier-1', 'Tier 2': 'tier-2', 'Tier 3': 'tier-3' };

type Quality = 'good' | 'mixed' | 'poor';
const qualityOf = (average: number | null): Quality => (average === null || average >= 75 ? 'good' : average >= 40 ? 'mixed' : 'poor');

function ago(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const ms = now - Date.parse(iso);
  if (ms < 45_000) return 'just now';
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return formatDate(iso);
}

const nameOf = (peer: InteractionPeer) => peer.agent?.name ?? shortAddress(peer.address);
const keyOf = (peer: InteractionPeer) => peer.agent?.agentId ?? peer.address;
const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function oneWay(stats: InteractionStats, verb: string, now: number): string {
  if (stats.reviews === 0) return `${verb} never`;
  return `${verb} ${stats.reviews}× (average ${Math.round(stats.average ?? 0)}; last ${stats.lastValue}, ${ago(stats.lastAt, now)})`;
}

function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

interface Point {
  x: number;
  y: number;
}

/** A gently curved path from a to b, bent `bend` px to one side, stopping short of both circles. */
function edgePath(a: Point, b: Point, startGap: number, endGap: number, bend: number): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const start = { x: a.x + ux * startGap, y: a.y + uy * startGap };
  const end = { x: b.x - ux * endGap, y: b.y - uy * endGap };
  const control = { x: (start.x + end.x) / 2 - uy * bend, y: (start.y + end.y) / 2 + ux * bend };
  return `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${control.x.toFixed(1)},${control.y.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`;
}

export function InteractionGraph({ agent }: { agent: AgentDetail }) {
  const { data, isLoading, error } = useInteractions(agent.agentId);
  const now = useNow(5_000);
  const router = useRouter();
  const markerId = useId().replace(/:/g, '');
  const [wrapRef, width] = useWidth(640);
  const [focused, setFocused] = useState<string | null>(null);

  const peers = data?.peers ?? [];
  const active = (peer: InteractionPeer) => now - Date.parse(peer.lastAt) < ACTIVE_MS;
  const activeCount = peers.filter(active).length;
  const rated = peers.filter((p) => p.given.reviews > 0).length;
  const ratedBy = peers.filter((p) => p.received.reviews > 0).length;

  const height = Math.round(Math.min(460, Math.max(340, width * 0.62)));
  const center = { x: width / 2, y: height / 2 };
  // The most recent peers, placed in a fixed order so a live update does not shuffle the circles.
  const shown = peers
    .slice(0, width < 520 ? 8 : 12)
    .toSorted((a, b) => keyOf(a).localeCompare(keyOf(b), undefined, { numeric: true }));
  const centerR = 40;
  const radiusOf = (peer: InteractionPeer) => 16 + Math.min(10, 3 * Math.sqrt(peer.given.reviews + peer.received.reviews));
  const rx = Math.max(90, center.x - 80);
  const ry = Math.max(90, center.y - 70);
  const startAngle = shown.length === 2 ? 0 : -Math.PI / 2;
  const placed = shown.map((peer, i) => {
    const angle = startAngle + (i * 2 * Math.PI) / Math.max(1, shown.length);
    return { peer, key: keyOf(peer), r: radiusOf(peer), x: center.x + rx * Math.cos(angle), y: center.y + ry * Math.sin(angle) };
  });
  const focusedPeer = peers.find((p) => keyOf(p) === focused) ?? null;

  const open = (peer: InteractionPeer) => {
    if (peer.agent) router.push(`/agent/${peer.agent.agentId}`);
  };
  const onKey = (event: KeyboardEvent, peer: InteractionPeer) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open(peer);
    }
  };

  let body;
  if (isLoading) body = <div className="graph-skeleton skeleton" style={{ height }} aria-hidden="true" />;
  else if (error) body = <p className="muted">Couldn’t load this agent’s interactions.</p>;
  else if (data === null) body = <p className="muted">This Reputed server does not report interactions yet.</p>;
  else if (peers.length === 0)
    body = <p className="muted graph-empty">No interactions yet. Agents appear here once this agent rates them or they rate it, which happens after a paid job.</p>;
  else
    body = (
      <>
        <svg className="graph" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${markerId}-desc`}>
          <desc id={`${markerId}-desc`}>
            {`${agent.name} has rated ${rated} agent(s) and been rated by ${ratedBy}. ${activeCount} interacted in the last 3 minutes.`}
          </desc>
          <defs>
            {(['good', 'mixed', 'poor'] as const).map((q) => (
              <marker key={q} id={`${markerId}-${q}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={`edge-head q-${q}`} />
              </marker>
            ))}
          </defs>

          {placed.map(({ peer, key, r, x, y }) => {
            const both = peer.given.reviews > 0 && peer.received.reviews > 0;
            const live = active(peer);
            const dim = focused !== null && focused !== key ? ' is-dim' : '';
            return (
              <g key={`edges-${key}`} className={`edges${dim}`}>
                {peer.given.reviews > 0 && (
                  <path
                    className={`edge q-${qualityOf(peer.given.average)}${live ? ' is-active' : ''}`}
                    d={edgePath(center, { x, y }, centerR + 4, r + 6, both ? 22 : 0)}
                    strokeWidth={1.5 + Math.min(4, peer.given.reviews * 0.6)}
                    markerEnd={`url(#${markerId}-${qualityOf(peer.given.average)})`}
                  />
                )}
                {peer.received.reviews > 0 && (
                  <path
                    className={`edge q-${qualityOf(peer.received.average)}${live ? ' is-active' : ''}`}
                    d={edgePath({ x, y }, center, r + 4, centerR + 6, both ? 22 : 0)}
                    strokeWidth={1.5 + Math.min(4, peer.received.reviews * 0.6)}
                    markerEnd={`url(#${markerId}-${qualityOf(peer.received.average)})`}
                  />
                )}
              </g>
            );
          })}

          <g className={`node node-center ${agent.score.isNew ? 'tier-new' : TIER_CLASS[agent.score.tier]}`} transform={`translate(${center.x},${center.y})`}>
            <circle className="node-body" r={centerR} />
            <text className="node-score" dy="0.35em">
              {Math.round(agent.score.value)}
            </text>
            <text className="node-label" y={centerR + 17}>
              {truncate(agent.name, 22)}
            </text>
          </g>

          {placed.map(({ peer, key, r, x, y }) => {
            const live = active(peer);
            const tier = peer.agent ? (peer.agent.score.isNew ? 'tier-new' : TIER_CLASS[peer.agent.score.tier]) : 'tier-none';
            const label = `${nameOf(peer)}${peer.agent ? ` #${peer.agent.agentId}, score ${Math.round(peer.agent.score.value)}` : ''}. ${oneWay(peer.given, `${agent.name} rated it`, now)}. ${oneWay(peer.received, `It rated ${agent.name}`, now)}.`;
            const dim = focused !== null && focused !== key ? ' is-dim' : '';
            // Labels go on the outer side, so the edges coming in from the center never cross them.
            const above = y < center.y - 1;
            return (
              <g
                key={key}
                className={`node ${tier}${live ? ' is-active' : ''}${peer.agent ? ' is-link' : ''}${dim}`}
                transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}
                tabIndex={0}
                role={peer.agent ? 'link' : 'img'}
                aria-label={label}
                onClick={() => open(peer)}
                onKeyDown={(event) => onKey(event, peer)}
                onMouseEnter={() => setFocused(key)}
                onMouseLeave={() => setFocused(null)}
                onFocus={() => setFocused(key)}
                onBlur={() => setFocused(null)}
              >
                {live && <circle className="node-halo" r={r + 7} />}
                <circle className="node-body" r={r} />
                <text className="node-score" dy="0.35em">
                  {peer.agent ? Math.round(peer.agent.score.value) : '?'}
                </text>
                <text className="node-label" y={above ? -(r + 22) : r + 15}>
                  {truncate(nameOf(peer), 18)}
                </text>
                <text className="node-sub" y={above ? -(r + 9) : r + 28}>
                  {peer.agent ? `#${peer.agent.agentId}` : peer.agentCount > 1 ? `${peer.agentCount} agents` : 'wallet'}
                </text>
              </g>
            );
          })}
        </svg>

        <div className="graph-info" aria-live="polite">
          {focusedPeer ? (
            <>
              <strong>{nameOf(focusedPeer)}</strong>
              {focusedPeer.agent ? (
                <span className="muted">
                  {' '}
                  #{focusedPeer.agent.agentId} · score {focusedPeer.agent.score.value.toFixed(2)} ({focusedPeer.agent.score.isNew ? 'inherited' : focusedPeer.agent.score.tier})
                </span>
              ) : (
                <span className="muted"> {focusedPeer.agentCount > 1 ? `an address with ${focusedPeer.agentCount} agents` : 'a wallet with no agent'}</span>
              )}
              <span>→ {oneWay(focusedPeer.given, 'This agent rated it', now)}</span>
              <span>← {oneWay(focusedPeer.received, 'It rated this agent', now)}</span>
            </>
          ) : (
            <span className="muted">
              Rated {rated} agent{rated === 1 ? '' : 's'} and was rated by {ratedBy}. Point at a circle for details{shown.some((p) => p.agent) ? ', click to open it' : ''}.
              {peers.length > shown.length ? ` ${peers.length - shown.length} older peer(s) not shown.` : ''}
            </span>
          )}
        </div>
      </>
    );

  return (
    <section className="card graph-card">
      <div className="section-head">
        <h2>
          Interactions
          {peers.length > 0 && <span className="count">{peers.length}</span>}
        </h2>
        {activeCount > 0 && (
          <span className="chip chip-live">
            <span className="live-dot" aria-hidden="true" /> {activeCount} interacting now
          </span>
        )}
      </div>
      <div ref={wrapRef} className="graph-wrap">
        {body}
      </div>
      {peers.length > 0 && (
        <ul className="graph-legend" aria-label="Legend">
          <li>
            <span className="legend-line q-good" /> rated 75+
          </li>
          <li>
            <span className="legend-line q-mixed" /> 40–74
          </li>
          <li>
            <span className="legend-line q-poor" /> under 40
          </li>
          <li>→ out: this agent rated it · ← in: it rated this agent</li>
          <li>
            <span className="legend-pulse" /> active in the last 3 min
          </li>
        </ul>
      )}
    </section>
  );
}
