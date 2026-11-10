'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { SearchKind } from '@washtrace/detect';
import { short, tokenLabel } from '@/lib/format';
import { hitRow, kindsFor, parseSearch, scopeOfPath, scopeParam, type Scope, type SearchReply } from '@/lib/search';

/** Hits shown per kind; the fetch brings 20 and the rest are one Enter away. */
const SHOWN = 5;
const WAIT_MS = 200;

const HEADING: Record<SearchKind, string> = { collections: 'Collections', tokens: 'Tokens', wallets: 'Wallets', trades: 'Trades' };

/** `sub`: a ring or token the best match is connected to, listed under it; it has no address line. */
type Option = { type: 'option'; key: string; href: string; line: string; address: string; sub?: boolean };
type Row = Option | { type: 'heading'; key: string; text: string } | { type: 'more'; key: string; text: string };

/**
 * The list's lines in order, the kind typed first: a heading per kind with
 * hits, its options, and a note when the kind has more than is shown. The best
 * match, the first option, is followed by what it is connected to.
 */
function listOf(hits: SearchReply, text: string, scope: Scope | null) {
  const rows: Row[] = [];
  for (const kind of kindsFor(parseSearch(text))) {
    const n = Math.min(hits[kind].length, SHOWN);
    if (n === 0) continue;
    rows.push({ type: 'heading', key: `h-${kind}`, text: HEADING[kind] });
    for (let i = 0; i < n; i++) {
      rows.push({ type: 'option', key: `${kind}-${i}`, ...hitRow(hits, kind, i, scope) });
      // A heading and one option so far: that option is the best match.
      if (rows.length === 2) rows.push(...connectedRows(hits, kind, scope));
    }
    if (hits[kind].length > SHOWN || hits.more[kind]) rows.push({ type: 'more', key: `m-${kind}`, text: 'and more · press Enter to see all' });
  }
  return rows;
}

/** The rings and tokens a wallet best match is in, under the collection searched; none for any other match. */
function connectedRows(hits: SearchReply, kind: SearchKind, scope: Scope | null): Option[] {
  const c = hits.connected;
  if (c === undefined || scope === null || kind !== 'wallets' || hits.wallets[0]?.address !== c.wallet) return [];
  const base = `/c/${scope.chainId}/${scope.address}`;
  return [
    ...c.rings.map((r) => ({ type: 'option' as const, key: `ring-${r.anchor}`, href: `${base}/r/${r.anchor}`, line: `Part of Ring ${r.rank}`, address: '', sub: true })),
    ...c.tokens.map((t) => ({ type: 'option' as const, key: `token-${t}`, href: `${base}/t/${t}`, line: `Traded token #${tokenLabel(t)}`, address: '', sub: true })),
  ];
}

/** True when a key press is someone typing, which the '/' shortcut must leave alone. */
function typing(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

/**
 * Feeds /go, which opens the one thing a search finds, or the results when it
 * finds none or several. While typing, a list under the input suggests hits;
 * Enter with none highlighted is the plain form submit, as without JavaScript.
 *
 * Under a collection it searches that collection, said in the placeholder and
 * on a chip that drops the scope; '/' anywhere else on the page focuses it.
 */
export function SearchBox({ id, className, watched = [], wide }: {
  id: string; className: string; watched?: readonly { chainId: number; address: string; name: string | null }[];
  /** Which layout this box is on show in: the sidebar holds one for each, and only the one on show takes '/'. */
  wide: boolean;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const path = usePathname();
  const here = scopeOfPath(path);
  // The scope follows the page: dropped by its chip, it comes back on the next collection page.
  const [dropped, setDropped] = useState<string | null>(null);
  const scope = here !== null && dropped !== path ? here : null;
  const scopeName = scope === null ? null : watched.find((c) => c.chainId === scope.chainId && c.address === scope.address)?.name ?? short(scope.address);
  const [text, setText] = useState('');
  const [hits, setHits] = useState<SearchReply | null>(null);
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
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}${scope ? `&scope=${scopeParam(scope)}` : ''}`, { signal: ctl.signal });
        const body = res.ok ? (await res.json()) as SearchReply : null;
        if (current) { setHits(body); setActive(-1); }
      } catch {
        if (current) setHits(null);
      }
    }, WAIT_MS);
    return () => { current = false; clearTimeout(timer); ctl.abort(); };
  }, [text, scope?.chainId, scope?.address]); // eslint-disable-line react-hooks/exhaustive-deps

  // '/' focuses the box on show: the sidebar's layout switches at 768 px, as its classes do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (window.matchMedia('(min-width: 768px)').matches !== wide) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [wide]);

  const rows = hits ? listOf(hits, text, scope) : [];
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
      <label className="sr-only" htmlFor={id}>{scopeName === null ? 'Collection, token number, wallet or transaction' : `Search ${scopeName}: token number, wallet or transaction`}</label>
      {scope === null ? null : <input type="hidden" name="scope" value={scopeParam(scope)} />}
      <input
        ref={input}
        id={id} name="q" placeholder={scopeName === null ? 'Search name, #token, address or tx  /' : `Search ${scopeName}…  /`} autoComplete="off"
        role="combobox" aria-expanded={shown} aria-controls={`${id}-list`} aria-autocomplete="list"
        aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
        // The hits on show are for the old text until the new reply: a highlight kept among them would open one on Enter.
        value={text} onChange={(e) => { setText(e.target.value); setOpen(true); setActive(-1); }}
        onKeyDown={onKeyDown} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        className="field w-full font-mono text-xs placeholder:text-muted-foreground"
      />
      {scopeName === null ? null : (
        <button type="button" onClick={() => setDropped(path)} title="Search every collection instead"
          className="mt-1 inline-flex items-center gap-1 rounded-full border bg-card px-2 py-px text-[11px] text-muted-foreground hover:text-foreground">
          In {scopeName} <span aria-hidden>✕</span><span className="sr-only">: search every collection</span>
        </button>
      )}
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
              className={`flex cursor-pointer flex-col gap-0.5 py-1 pr-2 text-foreground aria-selected:bg-muted ${r.sub ? 'pl-5' : 'pl-2'}`}
            >
              <span className={r.sub ? 'text-muted-foreground' : 'font-medium'}>{r.sub ? <span aria-hidden>↳ </span> : null}{r.line}</span>
              {r.sub ? null : <span className="font-mono text-[11px] text-muted-foreground">{short(r.address)}</span>}
            </li>
          );
        }) : null}
      </ul>
    </form>
  );
}
