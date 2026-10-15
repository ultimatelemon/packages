import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/** The slice of a pino-style logger this package calls. */
export interface Logger {
  error(obj: object, msg?: string): void;
}

export interface McpHttpOptions {
  /** Builds a fresh server per request; the transport is stateless. */
  createMcpServer: () => McpServer;
  port: number;
  /** Interface to listen on. Default `0.0.0.0`. */
  host?: string;
  /** Prefix a proxy leaves on the path, e.g. `/ns`. Both `/mcp` and `<basePath>/mcp` are served. */
  basePath?: string;
  /** Readiness for `/healthz`; return false for a 503. Default: always ready. */
  health?: () => boolean | Promise<boolean>;
  logger?: Logger;
}

export interface McpHttpServer {
  /** Full URL of the MCP endpoint, e.g. `http://localhost:3000/mcp`. */
  url: string;
  /** The port actually bound, useful with `port: 0`. */
  port: number;
  close(): Promise<void>;
}

const silent: Logger = { error: () => {} };

// PKG-10: Node's `Server.close()` waits for every still-open connection to go
// idle on its own; a keep-alive client that goes idle (or stays busy) *after*
// close() has already fired its one-off `closeIdleConnections()` call is
// never swept again, so the returned promise would never settle. We sweep
// idle connections repeatedly and, as a last resort, force every remaining
// connection closed after a fixed grace period - allowing in-flight requests
// a chance to finish first. 5000ms mirrors `DEFAULT_CONNECTION_TIMEOUT_MS` in
// packages/drizzle/src/client.ts and stays well under the grace period an
// orchestrator (Dokploy/k8s) gives a process before SIGKILL (typically
// 10-30s). This is intentionally internal and not exposed on `McpHttpOptions`.
const FORCE_CLOSE_TIMEOUT_MS = 5000;
const IDLE_SWEEP_INTERVAL_MS = 250;

function normalizeBasePath(basePath = ''): string {
  const trimmed = basePath.replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, message: string) {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null
  });
}

// PKG-10: closes `http`, letting in-flight requests finish normally. A
// one-off `closeIdleConnections()` call only catches connections that are
// already idle at the exact moment close() runs; any connection that is
// still mid-request at that moment, and only goes idle afterwards, would
// otherwise never be swept, so we repeat the sweep on an interval instead. If
// connections are still open once FORCE_CLOSE_TIMEOUT_MS has passed - e.g. a
// keep-alive client that never goes idle - `closeAllConnections()`
// force-closes whatever remains so the returned promise always settles and
// the port is always released. Both timers are unref'd and are always
// cleared once `http`'s own close callback fires, on every path (success,
// forced, or error).
function closeHttpServer(http: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const sweep = setInterval(() => {
      http.closeIdleConnections();
    }, IDLE_SWEEP_INTERVAL_MS).unref();
    const forceExit = setTimeout(() => {
      http.closeAllConnections();
    }, FORCE_CLOSE_TIMEOUT_MS).unref();

    http.close((error) => {
      clearInterval(sweep);
      clearTimeout(forceExit);
      if (error) reject(error);
      else resolve();
    });
    http.closeIdleConnections();
  });
}

export async function startMcpHttpServer(
  options: McpHttpOptions
): Promise<McpHttpServer> {
  const logger = options.logger ?? silent;
  const base = normalizeBasePath(options.basePath);
  const mcpPaths = new Set([`${base}/mcp`, '/mcp']);
  const healthPaths = new Set([`${base}/healthz`, '/healthz']);

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    // Stateless mode has no session to attach a GET stream or a DELETE to.
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      jsonRpcError(res, 405, 'Method not allowed');
      return;
    }
    const server = options.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on('close', () => {
      // This listener is synchronous, so try/catch can't catch a later
      // rejection; guard each call with its own .catch() instead and log it.
      transport.close().catch((error: unknown) => {
        logger.error(
          { err: String(error), url: req.url },
          'transport close failed'
        );
      });
      server.close().catch((error: unknown) => {
        logger.error(
          { err: String(error), url: req.url },
          'mcp server close failed'
        );
      });
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (healthPaths.has(path) && req.method === 'GET') {
      const ok = options.health ? await options.health() : true;
      sendJson(res, ok ? 200 : 503, { status: ok ? 'ok' : 'starting' });
      return;
    }
    if (mcpPaths.has(path)) {
      await handleMcp(req, res);
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  }

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error({ err: String(error), url: req.url }, 'request failed');
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
      else res.end();
    });
  });

  const host = options.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  const port =
    typeof address === 'object' && address ? address.port : options.port;
  const shownHost = host === '0.0.0.0' ? 'localhost' : host;

  return {
    url: `http://${shownHost}:${String(port)}${base}/mcp`,
    port,
    close: () => closeHttpServer(http)
  };
}
