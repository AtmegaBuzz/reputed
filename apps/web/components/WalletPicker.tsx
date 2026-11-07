'use client';

import { useId } from 'react';
import type { Connector } from 'wagmi';
import { Dialog } from './review/Dialog';

interface Props {
  open: boolean;
  connectors: readonly Connector[];
  onPick: (connector: Connector) => void;
  onClose: () => void;
}

const HINTS: Record<string, string> = {
  walletConnect: 'HashPack mobile, by QR code',
};

/** HashPack's extension announces itself over EIP-6963 under its own name and rdns. */
function isHashPack(connector: Connector): boolean {
  return /hashpack/i.test(connector.name) || /hashpack/i.test(connector.rdns?.toString() ?? '');
}

/** HashPack only: its extension when installed, and WalletConnect for the mobile app. */
export function walletChoices(connectors: readonly Connector[]): Connector[] {
  const unique = connectors.filter((c, i) => connectors.findIndex((o) => o.id === c.id) === i);
  return unique.filter((c) => c.id === 'walletConnect' || (c.type === 'injected' && isHashPack(c)));
}

function label(connector: Connector): string {
  return connector.id === 'walletConnect' ? 'HashPack (WalletConnect)' : connector.name;
}

export function WalletPicker({ open, connectors, onPick, onClose }: Props) {
  const titleId = useId();
  return (
    <Dialog open={open} onClose={onClose} labelledBy={titleId} className="wallet-picker">
      <div className="dialog-head">
        <h2 id={titleId}>Connect HashPack</h2>
        <button type="button" className="btn btn-outline btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted">Use an ECDSA account on Hedera testnet. HashPack&apos;s default Ed25519 accounts can&apos;t sign here.</p>
      <ul className="wallet-options">
        {connectors.map((connector) => (
          <li key={connector.uid}>
            <button type="button" className="wallet-option" onClick={() => onPick(connector)}>
              {connector.icon ? <img src={connector.icon} alt="" width={28} height={28} /> : <span className="wallet-option-icon" aria-hidden />}
              <span>
                <strong>{label(connector)}</strong>
                {HINTS[connector.id] && <small>{HINTS[connector.id]}</small>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
