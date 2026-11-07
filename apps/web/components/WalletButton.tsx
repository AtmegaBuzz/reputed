'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useConnect, useConnectors, type Connector } from 'wagmi';
import { hashscan } from '@reputed/shared';
import { shortAddress } from '@/lib/format';
import { allowSignInPrompt } from '@/lib/session';
import { useCreator } from '@/lib/useCreator';
import { useIdentity, useSignOut } from '@/lib/useIdentity';
import { describeWalletError } from '@/lib/walletError';
import { useToast } from './Toasts';
import { VerifiedCreatorBadge } from './VerifiedCreatorBadge';
import { WalletPicker, walletChoices } from './WalletPicker';

/** Opens the wallet picker, or connects at once when only one wallet is on offer. */
function useConnectFlow() {
  const connectors = useConnectors();
  const { connect, isPending } = useConnect();
  const { toast } = useToast();
  const [picking, setPicking] = useState(false);
  const choices = walletChoices(connectors);

  const connectWith = (connector: Connector) => {
    // Closed first: the WalletConnect QR modal can't show above an open <dialog>.
    setPicking(false);
    // A deliberate connect lifts the "declined" mark, so SessionSync may ask for a signature again.
    allowSignInPrompt();
    connect(
      { connector },
      {
        onError: (err) => {
          const { rejected, message } = describeWalletError(err);
          if (!rejected) toast('error', message || 'Could not connect the wallet.');
        },
      },
    );
  };

  const start = () => {
    if (choices.length === 0) {
      toast('error', 'HashPack not found. Install the HashPack extension, then reload.');
    } else if (choices.length === 1) {
      connectWith(choices[0]!);
    } else {
      setPicking(true);
    }
  };

  const picker = <WalletPicker open={picking} connectors={choices} onPick={connectWith} onClose={() => setPicking(false)} />;
  return { start, isPending, picker };
}

/** A button that connects a wallet. For a wallet that is only remembered, say "Reconnect wallet". */
export function ConnectButton({ children = 'Connect wallet' }: { children?: ReactNode }) {
  const { start, isPending, picker } = useConnectFlow();
  return (
    <>
      <button type="button" className="btn btn-primary" disabled={isPending} onClick={start}>
        {isPending ? 'Connecting…' : children}
      </button>
      {picker}
    </>
  );
}

/**
 * The header's wallet control. A signed-in wallet shows even when it is not connected, marked
 * "Not connected" with Reconnect in the menu, because reading needs only the address.
 */
export function WalletButton() {
  const { address, live } = useIdentity();
  const signOut = useSignOut();
  const { start, isPending, picker } = useConnectFlow();
  const creator = useCreator(address);
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!address) {
    return (
      <>
        <button type="button" className="btn btn-primary" disabled={isPending} onClick={start}>
          {isPending ? 'Connecting…' : 'Connect wallet'}
        </button>
        {picker}
      </>
    );
  }

  return (
    <div className="wallet" ref={menuRef}>
      <button type="button" className="btn btn-outline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mono">{shortAddress(address)}</span>
        {creator.data && <VerifiedCreatorBadge />}
        {!live && <span className="muted">Not connected</span>}
      </button>
      {open && (
        <div className="menu" role="menu">
          {!live && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                start();
              }}
            >
              Reconnect wallet
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              navigator.clipboard.writeText(address).then(
                () => toast('success', 'Address copied'),
                () => toast('error', 'Could not copy the address.'),
              );
              setOpen(false);
            }}
          >
            Copy address
          </button>
          <a role="menuitem" href={hashscan.address(address)} target="_blank" rel="noreferrer">
            View on HashScan
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              signOut();
              setOpen(false);
            }}
          >
            {live ? 'Disconnect' : 'Sign out'}
          </button>
        </div>
      )}
      {picker}
    </div>
  );
}
