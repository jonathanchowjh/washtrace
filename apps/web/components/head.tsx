import type { ReactNode } from 'react';
import Link from 'next/link';

/** A page's title, the trail back up to it, and whatever it states on the right. */
export function Head({ title, crumb = [], sub, children }: {
  title: ReactNode;
  crumb?: { href: string; label: string }[];
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b pt-5 pb-3">
      <div className="min-w-0">
        {crumb.length > 0 ? (
          <nav aria-label="Trail" className="mb-0.5 flex flex-wrap gap-1 text-xs text-muted-foreground">
            {crumb.map((c) => (
              <span key={c.href} className="after:ml-1 after:content-['/'] last:after:content-none">
                <Link href={c.href} className="hover:text-foreground hover:underline">{c.label}</Link>
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-3">{children}</div> : null}
    </header>
  );
}

/** A failed read, said where its rows would be. Never an empty list. */
export function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="my-5 max-w-2xl rounded-md border border-cycle/40 bg-cycle-surface p-4">
      <p className="font-medium text-cycle">{title}</p>
      <div className="mt-1 text-body">{children}</div>
    </div>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside ? <div className="text-xs text-muted-foreground">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}
