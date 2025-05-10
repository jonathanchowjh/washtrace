import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Sidebar } from '@/components/sidebar';
import { store } from '@/lib/store';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'washtrace', template: '%s · washtrace' },
  description: 'NFT wash trading detection: cycles in transfer graphs, and the money that closes them.',
};

const THEME_SCRIPT = `try{var t=localStorage.getItem('washtrace.theme');if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Reads process.env and the store: never prerendered.
  await connection();
  let watched: { chainId: number; address: string; name: string | null }[] = [];
  try {
    watched = (await store().collections()).map((c) => ({ chainId: c.chainId, address: c.address, name: c.name }));
  } catch {
    // The page under this layout says what is wrong; the sidebar just lists nothing.
  }
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before first paint: a saved choice wins over the OS. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <div className="grid min-h-screen grid-cols-[minmax(0,1fr)] max-md:grid-rows-[auto_1fr] md:grid-cols-[232px_minmax(0,1fr)]">
          <Sidebar watched={watched} />
          <main className="min-w-0 px-4 pb-20 text-sm md:px-8"><div className="mx-auto max-w-6xl">{children}</div></main>
        </div>
      </body>
    </html>
  );
}
