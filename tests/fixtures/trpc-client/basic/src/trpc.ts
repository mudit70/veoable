import { createTRPCReact } from '@trpc/react-query';

// Bare shape; the real generic argument (AppRouter) is irrelevant
// for the regex-style visitor.
export const trpc = createTRPCReact<any>();
