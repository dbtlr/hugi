/**
 * The run page's listener: Bun's HTTP server on `127.0.0.1` and no other address. Each request is
 * answered by `answerRunPageRequest`, apart from the coordinator's loop. Closing it drops any open
 * connection, so a stop never waits on a browser.
 */
import { answerRunPageRequest } from './http';
import type { RunPageContext } from './http';

/** The page answers on this address only; something outside Hugi makes it reachable at `web.url`. */
export const RUN_PAGE_HOSTNAME = '127.0.0.1';

/** An open listener: where it listens, and how to close it. */
export type RunPageServer = {
  readonly hostname: string;
  readonly port: number;
  readonly close: () => void;
};

/**
 * Listen on `127.0.0.1:<port>` (`port` 0 picks a free one, for tests). Throws when the port
 * cannot be opened. The Host check uses the port the listener actually has.
 */
export async function openRunPageServer(context: RunPageContext): Promise<RunPageServer> {
  let port = context.port;
  const server = Bun.serve({
    development: false,
    fetch: (request) => answerRunPageRequest(request, { ...context, port }),
    hostname: RUN_PAGE_HOSTNAME,
    port: context.port,
    // Never share the port: a second listener on it must fail, not split its requests.
    reusePort: false,
  });
  port = server.port ?? context.port;
  return {
    close: () => void server.stop(true),
    hostname: server.hostname ?? RUN_PAGE_HOSTNAME,
    port,
  };
}
