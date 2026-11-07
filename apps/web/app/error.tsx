'use client';

import { Head, Problem, STORE_DOWN } from '@/components/head';

/**
 * What a page shows when its read throws: the collection, flagged, token,
 * wallet and trade pages await the store with no catch of their own, and the
 * pages that do catch say the same words. A client file, so it imports only
 * head.tsx, which reaches nothing of the store.
 *
 * `retry` is Next's refresh-and-reset: a store read that threw on the server
 * is in the page's payload, so `reset` alone would re-render the same error.
 * In production Next replaces `message` with a generic sentence and sets
 * `digest`, the key to the server's log line.
 */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <>
      <Head title="This page could not be read" />
      <Problem title={STORE_DOWN}>
        {error.digest ? <>The web server&rsquo;s log has the details (digest {error.digest}).</> : error.message}{' '}
        <button type="button" onClick={retry} className="btn">Try again</button>
      </Problem>
    </>
  );
}
