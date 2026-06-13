'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

/** The theme the page shows now: the saved choice stamped on <html> by the layout's script, else the OS's. */
function effective(): Theme {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Switches the console between light and dark. Until it is pressed the console
 * follows the OS; a press is kept in this browser (localStorage can be blocked,
 * and then the choice lasts only until the page is closed).
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(effective()), []);

  if (theme === null) return <span className="block h-7 w-28" />;
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} mode`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem('washtrace.theme', next); } catch { /* blocked storage: follow the OS next visit */ }
        setTheme(next);
      }}
      className="flex items-center gap-2 rounded-[5px] border bg-card px-2 py-1 whitespace-nowrap text-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
    >
      {next === 'dark' ? '☾ Dark mode' : '☀ Light mode'}
    </button>
  );
}
