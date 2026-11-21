'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Re-reads the page from the server every few seconds while a run is still
 * moving, and only while the tab is visible. It never writes anything.
 */
export function LiveRefresh({ active, everyMs = 5_000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs, router]);
  return active ? (
    <span className="live" role="status">
      Live: updates every {Math.round(everyMs / 1000)} seconds
    </span>
  ) : null;
}
