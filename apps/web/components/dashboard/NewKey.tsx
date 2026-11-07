'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { zeroAddress, type Address } from 'viem';
import { creatorRegistryAbi, grantAddress, newApiKey } from '@reputed/shared';
import { chainClient } from '@/lib/chainClient';
import { CREATOR_REGISTRY, GAS } from '@/lib/contracts';
import { saveGrantLabel } from '@/lib/grantLabels';
import { CostHint } from '../CostHint';
import { useWalletSend } from '@/lib/walletSend';
import { TransactionButton } from '../TransactionButton';

const DAY_SECONDS = 86_400;

interface Draft {
  key: string;
  grant: Address;
  label: string;
  days: number;
  maxAgents: number;
}

/**
 * Makes the key in the browser, shows it, and only then asks the wallet to authorize its address.
 * Showing it first means a closed tab cannot lose a key that is already on-chain.
 */
export function NewKey({ creator }: { creator: Address }) {
  const queryClient = useQueryClient();
  const { writeContract: writeContractAsync } = useWalletSend();
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(90);
  const [maxAgents, setMaxAgents] = useState(10);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [copied, setCopied] = useState(false);

  const valid = Number.isInteger(days) && days >= 1 && days <= 365 && Number.isInteger(maxAgents) && maxAgents >= 1 && maxAgents <= 1000;

  function start() {
    // 32 random bytes from this browser. Only the address derived from them goes on-chain.
    const key = newApiKey('test');
    setDraft({ key, grant: grantAddress(key), label, days, maxAgents });
    setAuthorized(false);
    setCopied(false);
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['grants', creator] });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  /** Finds a lost authorize: a grant row with a creator set means the transaction landed. */
  async function onChain(grant: Address): Promise<true | null> {
    const [owner] = await chainClient.readContract({
      address: CREATOR_REGISTRY,
      abi: creatorRegistryAbi,
      functionName: 'grants',
      args: [grant],
    });
    return owner !== zeroAddress ? true : null;
  }

  if (!draft) {
    return (
      <div className="card">
        <h3>Create an API key</h3>
        <div className="field">
          <label htmlFor="key-label">Name (only you see it)</label>
          <input id="key-label" className="input" value={label} maxLength={60} placeholder="Trading bots" onChange={(event) => setLabel(event.target.value)} />
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="key-days">Valid for (days)</label>
            <input id="key-days" className="input" type="number" min={1} max={365} value={days} onChange={(event) => setDays(Number(event.target.value))} />
          </div>
          <div className="field">
            <label htmlFor="key-max">Most agents it can link</label>
            <input id="key-max" className="input" type="number" min={1} max={1000} value={maxAgents} onChange={(event) => setMaxAgents(Number(event.target.value))} />
          </div>
        </div>
        <p className="onboard-text muted">
          Anyone holding the key can link up to this many agents to you before it expires, so keep it secret. You can revoke it any time.
        </p>
        <div>
          <button type="button" className="btn btn-primary" disabled={!valid} onClick={start}>
            Create key
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>{authorized ? 'Your API key' : 'Save your key, then authorize it'}</h3>
      <p className="onboard-text">
        This is the only time the key is shown. Reputed never sees it; only its address goes on Hedera.
      </p>
      <pre className="code-block" data-testid="new-api-key">
        <code>{draft.key}</code>
      </pre>
      <div className="row">
        <button type="button" className="btn btn-outline" onClick={() => void copy(draft.key)}>
          {copied ? 'Copied' : 'Copy key'}
        </button>
      </div>

      {!authorized ? (
        <>
          <p className="onboard-text muted">
            Authorize it with your wallet so agents can use it: valid {draft.days} days, up to {draft.maxAgents} agents.
          </p>
          <TransactionButton
            label="Authorize on Hedera"
            onSend={() =>
              writeContractAsync({
                address: CREATOR_REGISTRY,
                abi: creatorRegistryAbi,
                functionName: 'authorizeGrant',
                args: [draft.grant, BigInt(Math.floor(Date.now() / 1000) + draft.days * DAY_SECONDS), draft.maxAgents],
                gas: GAS.authorizeGrant,
              })
            }
            onConfirmed={() => {
              // The label is saved only once the grant exists, keyed by its address.
              saveGrantLabel(draft.grant, draft.label);
              setAuthorized(true);
              refresh();
            }}
            findSent={() => onChain(draft.grant)}
            onFound={() => {
              saveGrantLabel(draft.grant, draft.label);
              setAuthorized(true);
              refresh();
            }}
          />
          <CostHint usd={0.01} />
        </>
      ) : (
        <>
          <p className="pay-ok">✓ Authorized. Agents can use this key now.</p>
          <div>
            <button type="button" className="btn btn-primary" onClick={() => setDraft(null)}>
              I&apos;ve saved it
            </button>
          </div>
        </>
      )}
    </div>
  );
}
