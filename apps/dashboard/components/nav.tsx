'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Workspace', match: (p: string) => p === '/' || p.startsWith('/requests') },
  { href: '/status', label: 'Status', match: (p: string) => p.startsWith('/status') },
  { href: '/backlog', label: 'Backlog', match: (p: string) => p.startsWith('/backlog') },
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
