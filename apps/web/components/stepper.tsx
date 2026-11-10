'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Step } from '@/lib/step';
import { num } from '@/lib/format';
import { typing } from '@/lib/utils';

/**
 * The line above an item opened from a list: back to the list, where it sits
 * in it, and ‹ › to its neighbours, also on K and J. The links work without
 * script; the keys add to them.
 */
export function Stepper({ step }: { step: Step }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      const to = e.key === 'j' ? step.next : e.key === 'k' ? step.prev : null;
      if (to === null) return;
      e.preventDefault();
      router.push(to.href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, router]);
  const edge = 'inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 font-medium text-foreground hover:bg-muted';
  return (
    <nav aria-label="Step through the list" className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-3 text-xs text-muted-foreground">
      <Link href={step.back.href} className="hover:text-foreground hover:underline">‹ {step.back.label}</Link>
      <span className="tabular-nums">{num(step.at)} of <Link href={step.back.href} className="hover:underline">{num(step.total)}</Link></span>
      {step.prev ? <Link href={step.prev.href} rel="prev" className={edge} title="Previous (K)">‹ {step.prev.label}</Link> : null}
      {step.next ? <Link href={step.next.href} rel="next" className={edge} title="Next (J)">{step.next.label} ›</Link> : null}
      <span aria-hidden className="max-sm:hidden"><kbd className="rounded border px-1 font-mono">K</kbd> <kbd className="rounded border px-1 font-mono">J</kbd></span>
    </nav>
  );
}
