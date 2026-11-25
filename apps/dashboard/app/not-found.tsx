import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="empty">
      There is no run with that id. <Link href="/runs">See every run</Link>.
    </div>
  );
}
