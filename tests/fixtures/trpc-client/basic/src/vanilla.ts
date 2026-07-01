import { createTRPCProxyClient } from '@trpc/client';

export const vanillaClient = createTRPCProxyClient<any>({
  links: [],
});
