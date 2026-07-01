import type { ReactNode } from 'react';

export const metadata = {
  title: 'Task Tracker',
  description: 'Tasks',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header style={{ padding: 16, borderBottom: '1px solid #eee' }}>
          <h1>Task Tracker</h1>
        </header>
        <main style={{ padding: 16 }}>{children}</main>
      </body>
    </html>
  );
}
