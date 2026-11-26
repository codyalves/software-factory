'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Home is the path through the factory: ask, queue, start, watch. Its two
// "Details" links open the fuller backlog and status pages, which belong to it.
const LINKS = [
  {
    href: '/',
    label: 'Home',
    match: (p: string) =>
      p === '/' || p.startsWith('/requests') || p.startsWith('/backlog') || p.startsWith('/status'),
  },
  { href: '/runs', label: 'Runs', match: (p: string) => p.startsWith('/runs') },
  { href: '/trace', label: 'Traceability', match: (p: string) => p.startsWith('/trace') },
  { href: '/audit', label: 'Audit log', match: (p: string) => p.startsWith('/audit') },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Sections">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={l.match(path) ? 'page' : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
