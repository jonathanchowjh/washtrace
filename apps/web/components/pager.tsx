import Link from 'next/link';

/**
 * One pager for every list that is cut into pages: the range shown, First,
 * Previous, a page box, Next and Last. It is a server component, so the box is
 * a plain GET form: its action and hidden inputs are read from `href(1)`, which
 * keeps every other filter in the URL, and its #fragment, when a page is typed. `pageParam` names
 * the page in the URL, so a page can hold several pagers that do not collide.
 * With one page it says only the count. `open` means `total` is only a lower
 * bound (the source cannot count the rest): the count says "more than", there
 * is no last page to jump to or to cap the box at, and Next is always offered.
 */
export function Pager({ total, page: asked, size, href, label = 'results', pageParam = 'page', open = false }: {
  total: number; page: number; size: number; href: (page: number) => string; label?: string; pageParam?: string; open?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages === 1 && !open) return <p className="mt-3 text-sm text-muted-foreground tabular-nums">{total.toLocaleString()} {label}</p>;
  const page = open ? Math.max(1, asked) : Math.min(pages, Math.max(1, asked));
  const first = (page - 1) * size + 1;
  const last = Math.min(total, page * size);
  const form = new URL(href(1), 'http://pager.invalid');
  const hidden = [...form.searchParams].filter(([k]) => k !== pageParam);
  return (
    <nav aria-label="Pages" className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
      <span className="text-muted-foreground tabular-nums">{first.toLocaleString()}–{last.toLocaleString()} of {open ? 'more than ' : ''}{total.toLocaleString()} {label}</span>
      <span className="flex flex-wrap items-center gap-1">
        <PageLink to={page > 1 ? href(1) : null}>« First</PageLink>
        <PageLink to={page > 1 ? href(page - 1) : null}>‹ Previous</PageLink>
        <form action={`${form.pathname}${form.hash}`} method="get" className="flex items-center gap-1.5 px-2 text-muted-foreground">
          {hidden.map(([k, v], i) => <input key={i} type="hidden" name={k} value={v} />)}
          <label className="flex items-center gap-1.5 tabular-nums">
            Page
            <input
              type="number" name={pageParam} min={1} max={open ? undefined : pages} defaultValue={page} aria-label="Page number"
              className="w-16 rounded-md border bg-card px-2 py-1 text-foreground tabular-nums"
            />
          </label>
          {open ? null : <span className="tabular-nums">of {pages.toLocaleString()}</span>}
        </form>
        <PageLink to={open || page < pages ? href(page + 1) : null}>Next ›</PageLink>
        {open ? null : <PageLink to={page < pages ? href(pages) : null}>Last »</PageLink>}
      </span>
    </nav>
  );
}

/** A link to a page, or the same box greyed out when there is none that way. */
function PageLink({ to, children }: { to: string | null; children: React.ReactNode }) {
  if (to === null) return <span className="rounded-md border px-2.5 py-1 text-muted-foreground opacity-50">{children}</span>;
  return <Link href={to} className="rounded-md border bg-card px-2.5 py-1 font-medium text-foreground hover:bg-muted">{children}</Link>;
}
