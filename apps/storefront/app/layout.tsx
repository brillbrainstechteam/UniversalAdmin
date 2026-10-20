import '@uc/ui/styles.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Shell } from '../lib/shell';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Online store',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
