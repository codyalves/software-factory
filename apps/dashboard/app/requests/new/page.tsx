import type { Metadata } from 'next';
import Link from 'next/link';
import { controlConfig, currentLogin, currentOwner, currentProject } from '@/lib/control';
import { RequestForm } from './request-form';

export const metadata: Metadata = { title: 'Write one issue' };

export default async function NewRequestPage() {
  const config = controlConfig();
  const [owner, login] = await Promise.all([currentOwner(), currentLogin()]);
  const repo = config ? await currentProject(config) : 'the target';
  return (
    <>
      <header className="page-head">
        <h1>Write one issue</h1>
        <p className="lede">
          For a single, well-understood change. The factory files it as an issue on {repo}, triages it, and
          builds it in the next session. For anything bigger, <Link href="/">plan it</Link> instead. Each
          acceptance criterion becomes a test the work has to pass.
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
