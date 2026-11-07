'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useReadContract } from 'wagmi';
import { HEDERA_TESTNET, creatorRegistryAbi, type AgentSummary } from '@reputed/shared';
import { chainClient } from '@/lib/chainClient';
import { CREATOR_REGISTRY, GAS } from '@/lib/contracts';
import { CostHint } from '../CostHint';
import { useWalletSend } from '@/lib/walletSend';
import { TransactionButton, type TxPhase } from '../TransactionButton';
import { Dialog, DialogDone } from '../review/Dialog';

const POLL_MS = 2_000;
const STOP_AFTER_MS = 60_000;

/**
 * The owner's row action on the agents table. The contract is the authority on whether an agent is
 * already reported, since the API only learns of it once indexed and a second report reverts.
 */
export function ReportCompromised({ agent }: { agent: AgentSummary }) {
  const queryClient = useQueryClient();
  const { writeContract: writeContractAsync } = useWalletSend();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<TxPhase>('idle');
  const cancel = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLSpanElement>(null);
  const agentId = BigInt(agent.agentId);
  const titleId = `report-title-${agent.agentId}`;
  const textId = `report-text-${agent.agentId}`;

  const compromisedAt = useReadContract({
    address: CREATOR_REGISTRY,
    abi: creatorRegistryAbi,
    functionName: 'compromisedAt',
    args: [agentId],
    chainId: HEDERA_TESTNET.id,
    query: { enabled: agent.status !== 'compromised' },
  });

  const reported = phase === 'done';

  // The table's Status column comes from the API, so refetch until the report has been indexed.
  const indexed = agent.status === 'compromised';
  useEffect(() => {
    if (!reported || indexed) return;
    const refetch = () => void queryClient.invalidateQueries({ queryKey: ['creator'] });
    refetch();
    const poll = setInterval(refetch, POLL_MS);
    const stop = setTimeout(() => clearInterval(poll), STOP_AFTER_MS);
    return () => {
      clearInterval(poll);
      clearTimeout(stop);
    };
  }, [reported, indexed, queryClient]);

  const refreshAgent = () => void queryClient.invalidateQueries({ queryKey: ['agent', agent.agentId] });

  /** compromisedAt stays 0 until reported, so any other value means the report landed. */
  async function findReport(): Promise<true | null> {
    const at = await chainClient.readContract({ address: CREATOR_REGISTRY, abi: creatorRegistryAbi, functionName: 'compromisedAt', args: [agentId] });
    return at !== 0n ? true : null;
  }

  function close() {
    setOpen(false);
    // The opener is gone by now, so hand focus to what replaced it.
    if (reported) requestAnimationFrame(() => done.current?.focus());
  }

  const alreadyReported = compromisedAt.data !== undefined && compromisedAt.data !== 0n;
  // A failed read leaves the action available: the contract still decides. Never unmount an open dialog.
  if (!open && (indexed || (alreadyReported && !reported) || compromisedAt.isLoading)) return null;

  return (
    <>
      {reported && !open ? (
        <span ref={done} tabIndex={-1} className="muted">
          Reported
        </span>
      ) : (
        <button type="button" className="btn btn-outline btn-small" onClick={() => setOpen(true)}>
          Report compromised
        </button>
      )}
      <Dialog
        open={open}
        onClose={close}
        busy={phase === 'confirming'}
        labelledBy={titleId}
        describedBy={textId}
        initialFocus={cancel}
      >
        <h2 id={titleId}>
          Report {agent.name} (#{agent.agentId}) compromised?
        </h2>
        <p id={textId}>Penalties after now will not count against you. This cannot be undone.</p>
        <div className={reported ? 'tx-finished' : undefined}>
          <TransactionButton
            label="Report compromised"
            onSend={() =>
              writeContractAsync({
                address: CREATOR_REGISTRY,
                abi: creatorRegistryAbi,
                functionName: 'reportCompromise',
                args: [agentId],
                gas: GAS.reportCompromise,
              })
            }
            onPhase={setPhase}
            onConfirmed={refreshAgent}
            findSent={findReport}
            onFound={refreshAgent}
          />
        </div>
        {phase === 'idle' && <CostHint usd={0.01} />}
        {reported ? (
          <DialogDone onClose={close} />
        ) : (
          <button ref={cancel} type="button" className="btn btn-outline" disabled={phase === 'confirming'} onClick={close}>
            Cancel
          </button>
        )}
      </Dialog>
    </>
  );
}
