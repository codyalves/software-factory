import type { Metadata } from 'next';
import Link from 'next/link';
import { controlConfig, currentLogin, currentOwner } from '@/lib/control';
import { RequestForm } from './request-form';

export const metadata: Metadata = { title: 'New request' };

export default async function NewRequestPage() {
  const config = controlConfig();
  const [owner, login] = await Promise.all([currentOwner(), currentLogin()]);
  return (
    <>
      <header className="page-head">
        <h1>New request</h1>
        <p className="lede">
          Describe the work. The factory files it as an issue on {config?.targetRepo ?? 'the target'}, triages
          it, and builds it in the next session. Each acceptance criterion becomes a test the work has to
          pass.
        </p>
      </header>
      {!config ? (
        <div className="empty">
          The control panel is not set up on this dashboard yet (see docs/dashboard.md).
        </div>
      ) : !owner ? (
        <div className="empty">
          {login ? (
            <>Signed in as {login}, who is not an owner of this factory, so this account can only read. </>
          ) : (
            <>
              <a href="/auth/login">Sign in with GitHub</a> as an owner to file a request.{' '}
            </>
          )}
          Anyone can read the <Link href="/backlog">backlog</Link>.
        </div>
      ) : (
        <RequestForm />
      )}
    </>
  );
}
