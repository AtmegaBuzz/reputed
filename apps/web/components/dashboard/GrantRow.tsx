'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import type { Address } from 'viem';
import { creatorRegistryAbi, type GrantSummary } from '@reputed/shared';
import { chainClient } from '@/lib/chainClient';
import { CREATOR_REGISTRY, GAS } from '@/lib/contracts';
import { getGrantLabel } from '@/lib/grantLabels';
import { ReportCompromised } from '../creator/ReportCompromised';
import { useWalletSend } from '@/lib/walletSend';
import { TransactionButton } from '../TransactionButton';

export type GrantState = 'active' | 'revoked' | 'expired' | 'full';

export function grantState(grant: GrantSummary): GrantState {
  if (grant.revoked) return 'revoked';
  if (grant.expired) return 'expired';
  if (grant.used >= grant.maxAgents) return 'full';
  return 'active';
}

const STATE_TEXT: Record<GrantState, string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
  full: 'Used up',
};

export function GrantRow({ grant, creator, canSign }: { grant: GrantSummary; creator: Address; canSign: boolean }) {
  const queryClient = useQueryClient();
  const { writeContract: writeContractAsync } = useWalletSend();
  const [label, setLabel] = useState<string | undefined>();
  // Read in an effect: the label is in this browser's storage, which the server render cannot see.
  useEffect(() => setLabel(getGrantLabel(grant.grantKey)), [grant.grantKey]);

  const state = grantState(grant);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['grants', creator] });

  /** `grants` returns (creator, expiresAt, maxAgents, used, revoked). */
  async function isRevoked(): Promise<true | null> {
    const row = await chainClient.readContract({ address: CREATOR_REGISTRY, abi: creatorRegistryAbi, functionName: 'grants', args: [grant.grantKey] });
    return row[4] ? true : null;
  }

  return (
    <li className="card grant-row">
      <div className="grant-head">
        <div>
          <strong>{label ?? 'API key'}</strong>{' '}
          <span className="mono muted" title={grant.grantKey}>
            {grant.grantKey.slice(0, 8)}…{grant.grantKey.slice(-4)}
          </span>
        </div>
        <span className={`badge ${state === 'active' ? 'tier-1' : 'tier-new'} tier-badge`}>{STATE_TEXT[state]}</span>
      </div>
      <p className="onboard-text muted">
        {grant.used} of {grant.maxAgents} agents linked · {grant.expired ? 'expired' : 'expires'} {new Date(grant.expiresAt).toLocaleDateString()}
      </p>

      {grant.agents.length > 0 && (
        <ul className="grant-agents">
          {grant.agents.map((agent) => (
            <li key={agent.agentId}>
              <Link href={`/agent/${agent.agentId}`}>
                {agent.name} <span className="muted">#{agent.agentId}</span>
              </Link>
              {canSign && <ReportCompromised agent={agent} />}
            </li>
          ))}
        </ul>
      )}

      {state === 'active' && canSign && (
        <div>
          <TransactionButton
            label="Revoke key"
            onSend={() =>
              writeContractAsync({
                address: CREATOR_REGISTRY,
                abi: creatorRegistryAbi,
                functionName: 'revokeGrant',
                args: [grant.grantKey],
                gas: GAS.revokeGrant,
              })
            }
            onConfirmed={refresh}
            findSent={isRevoked}
            onFound={refresh}
          />
          <p className="onboard-text muted">Revoking stops new agents. Agents it already linked stay linked; report any you no longer trust.</p>
        </div>
      )}
    </li>
  );
}
