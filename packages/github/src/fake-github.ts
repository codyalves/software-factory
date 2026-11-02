import type { Fetch } from './client.ts';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

type Route = (request: RecordedRequest) => Response | Promise<Response>;

/**
 * An in-memory GitHub for tests: routes by "METHOD /path" (query string
 * included) and records every request.
 */
export function fakeGitHub(routes: Record<string, Route>): { fetch: Fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];

  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);

    const route = routes[`${request.method} ${request.path}`];
    return route
      ? route(request)
      : new Response(`no route for ${request.method} ${request.path}`, { status: 404 });
  };

  return { fetch: fetchImpl, requests };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
