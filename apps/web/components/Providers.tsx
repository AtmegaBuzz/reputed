'use client';

import { useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveUpdates } from '@/lib/live';
import { wagmiConfig } from '@/lib/wagmi';
import { SessionSync } from './SessionSync';
import { ToastProvider } from './Toasts';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <LiveUpdates>
          <ToastProvider>
            <SessionSync />
            {children}
          </ToastProvider>
        </LiveUpdates>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
