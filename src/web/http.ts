/**
 * How the run page answers a request (README, "The run page"): the Host check, the one path it
 * serves, the methods, and the headers every answer carries. A request is checked in that order,
 * so a wrong host, a wrong path and a wrong method are all answered before the run is looked up,
 * and a path that is not a run's is answered before anything on disk is read.
 */
import { messageOf } from '../errors';
import { RUN_DIRECTORY_NAME } from '../runs/store';
import {
  renderNotFound,
  renderRunPage,
  renderUnexpectedError,
  renderWrongHost,
  renderWrongMethod,
} from './render';
import type { RenderedPage } from './render';
import type { RunPageData } from './run-data';

/** The page runs no script and loads nothing from elsewhere; its one stylesheet is inline. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const ALLOWED_METHODS = 'GET, HEAD';

/** What answering a request needs. */
export type RunPageContext = {
  /** The port the page listens on, which a loopback `Host` must name. */
  readonly port: number;
  /** `web.url`, whose host (with its port, if any) a `Host` may also name. */
  readonly origin: string;
  /** Read a run whose id has a run directory's form. */
  readonly loadRun: (runId: string) => Promise<RunPageData>;
  readonly now: () => Date;
  readonly log: { readonly error: (message: string) => void };
};

/** The `Host` values the page answers: the loopback names with its port, and the url's host. */
export function allowedHosts(port: number, origin: string): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, new URL(origin).host.toLowerCase()]);
}

/** The run id a path names, or undefined when the path is not a run page's. */
export function runIdOfPath(pathname: string): string | undefined {
  const match = /^\/runs\/(?<id>[^/]+)$/u.exec(pathname);
  const id = match?.groups?.id;
  return id !== undefined && RUN_DIRECTORY_NAME.test(id) ? id : undefined;
}

function respond(page: RenderedPage, method: string, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...(page.refreshSeconds === undefined ? {} : { Refresh: String(page.refreshSeconds) }),
    ...extra,
  };
  return new Response(method === 'HEAD' ? null : page.html, { headers, status: page.status });
}

/** The request's path, or `''` when its url does not parse (as a `CONNECT` target may not). */
function pathnameOf(request: Request): string {
  return URL.parse(request.url)?.pathname ?? '';
}

async function answer(request: Request, context: RunPageContext): Promise<Response> {
  const { method } = request;
  // The Host is checked before the url is parsed: a missing or malformed Host is simply not allowed.
  const host = (request.headers.get('host') ?? '').toLowerCase();
  if (!allowedHosts(context.port, context.origin).has(host)) {
    return respond(renderWrongHost(), method);
  }
  const runId = runIdOfPath(pathnameOf(request));
  if (runId === undefined) {
    return respond(renderNotFound(), method);
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return respond(renderWrongMethod(), method, { Allow: ALLOWED_METHODS });
  }
  return respond(renderRunPage(await context.loadRun(runId), context.now()), method);
}

/**
 * Answer one request. An unexpected error is logged and answered `500` with no detail, so it
 * never reaches the page or the loop.
 */
export async function answerRunPageRequest(
  request: Request,
  context: RunPageContext,
): Promise<Response> {
  try {
    return await answer(request, context);
  } catch (error) {
    context.log.error(
      `The run page could not answer ${request.method} ${pathnameOf(request)}: ${messageOf(error)}`,
    );
    return respond(renderUnexpectedError(), request.method);
  }
}
