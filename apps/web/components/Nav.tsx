'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useIdentity } from '@/lib/useIdentity';
import { Logo } from './icons';
import { LivePill } from './LivePill';
import { NetworkPill } from './NetworkPill';
import { WalletButton } from './WalletButton';

interface Item {
  href: string;
  label: string;
  /** True when the current path is this item or a page under it. */
  match: (pathname: string) => boolean;
}

/** The one navigation bar: inside the hero on the landing page, inside the top panel everywhere else. */
export function Nav() {
  const { address } = useIdentity();
  const pathname = usePathname();

  const items: Item[] = [
    { href: '/', label: 'Home', match: (p) => p === '/' },
    { href: '/explore', label: 'Explore', match: (p) => p === '/explore' || p.startsWith('/agent/') || (p.startsWith('/creator/') && p !== `/creator/${address}`) },
  ];
  if (address) items.push({ href: `/creator/${address}`, label: 'My agents', match: (p) => p === `/creator/${address}` });
  items.push({ href: '/dashboard', label: 'Dashboard', match: (p) => p === '/dashboard' || p === '/onboard' || p === '/verify' });

  return (
    <div className="navbar">
      <Link href="/" className="brand" aria-label="Reputed home">
        <Logo /> Reputed
      </Link>
      <nav className="pill-nav" aria-label="Main">
        {items.map((item) => {
          const active = item.match(pathname);
          return (
            <Link key={item.href} href={item.href} className={active ? 'is-active' : undefined} aria-current={active ? 'page' : undefined}>
              {active && <span className="dot" aria-hidden="true" />}
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="navbar-right">
        <LivePill />
        <NetworkPill />
        <WalletButton />
      </div>
    </div>
  );
}
