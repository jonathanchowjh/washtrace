'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { SearchHits, SearchKind } from '@washtrace/detect';
import { short } from '@/lib/format';
import { hitRow, parseSearch, SEARCH_KINDS } from '@/lib/search';

/** Hits shown per kind; the fetch brings 20 and the rest are one Enter away. */
const SHOWN = 5;
const WAIT_MS = 200;

const HEADING: Record<SearchKind, string> = { collections: 'Collections', tokens: 'Tokens', wallets: 'Wallets', trades: 'Trades' };

type Option = { type: 'option'; key: string; href: string; line: string; address: string };
type Row = Option | { type: 'heading'; key: string; text: string } | { type: 'more'; key: string; text: string };

/** The list's lines in order:a heading per kind with hits, its options, and a note when the kind has more than is shown. */
function listOf(hits: SearchHits) {
  const rows: Row[] = [];
  for (const kind of SEARCH_KINDS) {
    const n = Math.min(hits[kind].length, SHOWN);
    if (n === 0) continue;
    rows.push({ type: 'heading', key: `h-${kind}`, text: HEADING[kind] });
    for (let i = 0; i < n; i++) rows.push({ type: 'option', key: `${kind}-${i}`, ...hitRow(hits, kind, i) });
    if (hits[kind].length > SHOWN || hits.more[kind]) rows.push({ type: 'more', key: `m-${kind}`, text: 'and more · press Enter to see all' });
  }
  return rows;
}

/**
 * Feeds /go, which opens the one thing a search finds, or the results when it
 * finds none or several. While typing, a list under the input suggests hits;
 * Enter with none highlighted is the plain form submit, as without JavaScript.
 */
export function SearchBox({ id, className }: { id: string; className: string }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [hits, setHits] = useState<SearchHits | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // The cleanup drops a reply whose text has since changed, so a slow answer to "te" never replaces the answer to "ter".
  useEffect(() => {
    const q = text.trim();
    if (parseSearch(q).kind === 'empty') { setHits(null); return; }
    let current = true;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
        const body = res.ok ? (await res.json()) as SearchHits : null;
        if (current) { setHits(body); setActive(-1); }
      } catch {
        if (current) setHits(null);
      }
    }, WAIT_MS);
    return () => { current = false; clearTimeout(timer); ctl.abort(); };
  }, [text]);

  const rows = hits ? listOf(hits) : [];
  const options = rows.filter((r): r is Option => r.type === 'option');
  const shown = open && hits !== null;
  const optionId = (i: number) => `${id}-opt-${i}`;

  const go = (href: string) => { setOpen(false); router.push(href); };
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (!shown || options.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive(active < 0 ? (step === 1 ? 0 : options.length - 1) : (active + step + options.length) % options.length);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      go(options[active]!.href);
    }
  }

  let seen = -1;
  return (
    <form action="/go" className={`relative ${className}`}>
      <label className="sr-only" htmlFor={id}>Collection, token number, wallet or transaction</label>
      <input
        id={id} name="q" placeholder="Search name, #token, address or tx" autoComplete="off"
        role="combobox" aria-expanded={shown} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
        // The hits on show are for the old text until the new reply: a highlight kept among them would open one on Enter.
        value={text} onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
        onKeyDown={onKeyDown} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        className="w-full rounded-[5px] border bg-card px-2 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
      />
      {/* Mouse-down on the list is held back so the input keeps focus, and a click lands before blur closes the list. */}
      <ul
        id={`${id}-list`} role="listbox" aria-label="Matches" hidden={!shown}
        onMouseDown={(e) => e.preventDefault()}
        className="absolute inset-x-0 top-full z-20 mt-1 max-h-96 overflow-y-auto rounded-md border bg-card py-1 text-xs shadow-md"
      >
        {shown && options.length === 0 ? (
          <li role="presentation" className="px-2 py-1.5 text-muted-foreground">No match. Press Enter to search everything.</li>
        ) : null}
        {shown ? rows.map((r) => {
          if (r.type === 'heading') return <li key={r.key} role="presentation" className="px-2 pt-1.5 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{r.text}</li>;
          if (r.type === 'more') return <li key={r.key} role="presentation" className="px-2 py-1 text-muted-foreground">{r.text}</li>;
          const i = ++seen;
          return (
            <li
              key={r.key} id={optionId(i)} role="option" aria-selected={i === active}
              onClick={() => go(r.href)} onMouseEnter={() => setActive(i)}
              className="flex cursor-pointer flex-col gap-0.5 px-2 py-1 text-foreground aria-selected:bg-muted"
            >
              <span className="font-medium">{r.line}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{short(r.address)}</span>
            </li>
          );
        }) : null}
      </ul>
    </form>
  );
}
