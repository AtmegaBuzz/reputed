'use client';

import { useQuery } from '@tanstack/react-query';
import type { AgentInteractions } from '@reputed/shared';
import { ApiRequestError, apiGet } from './api';

/** Who the agent has reviewed and been reviewed by. `null` when the server has no such route or agent. */
export function useInteractions(agentId: string) {
  return useQuery({
    queryKey: ['interactions', agentId],
    enabled: /^\d+$/.test(agentId),
    retry: false,
    queryFn: async ({ signal }): Promise<AgentInteractions | null> => {
      try {
        return await apiGet<AgentInteractions>(`/api/agents/${agentId}/interactions`, signal);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      }
    },
  });
}
