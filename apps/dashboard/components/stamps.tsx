import { STATE_LABEL, stateTone } from '@/lib/format';

export function StateStamp({ state }: { state: string }) {
  return <span className={`stamp stamp-${stateTone(state)}`}>{STATE_LABEL[state] ?? state}</span>;
}

export function Risk({ level }: { level: string | null }) {
  if (!level) return <span className="muted">Not assessed</span>;
  return <span className={`risk risk-${level}`}>{level[0]?.toUpperCase() + level.slice(1)} risk</span>;
}

export function Verdict({ passed }: { passed: boolean }) {
  return <span className={`verdict ${passed ? 'pass' : 'fail'}`}>{passed ? 'Pass' : 'Fail'}</span>;
}
