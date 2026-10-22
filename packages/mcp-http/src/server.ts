import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import { isEncrypted } from '@ultimatelemon-eu/crypto';
import {
  createOAuthHandler,
  type OAuthHandler,
  type OAuthOptions
} from './oauth.js';

/** The slice of a pino-style logger this package calls. */
export interface Logger {
  error(obj: object, msg?: string): void;
}

export interface RequestContext {
  /** The caller's own key for the upstream API. Set when `apiKey` is configured. */
  apiKey?: string;
  /** Headers of the HTTP request, for per-caller settings beyond the key. */
  headers: Headers;
  /** Set when the caller signed in through `oauth`; `apiKey` then holds the upstream token. */
  oauth?: { settings: Record<string, string> };
}

export interface ApiKeyOptions {
  /** Added to the 401 message, e.g. where to get a key. */
  hint?: string;
}

export interface McpHttpOptions {
  /** Builds a fresh server per request; the transport is stateless. */
  createMcpServer: (context: RequestContext) => McpServer | Promise<McpServer>;
  port: number;
  /** Interface to listen on. Default `0.0.0.0`. */
  host?: string;
  /** Prefix a proxy leaves on the path, e.g. `/ns`. MCP is served on `/mcp`, `<basePath>/mcp` and `<basePath>` itself. */
  basePath?: string;
  /** Readiness for `/healthz`; return false for a 503. Default: always ready. */
  health?: () => boolean | Promise<boolean>;
  /** Require every MCP request to carry the caller's key in `X-Api-Key` or `Authorization: Bearer`. */
  apiKey?: ApiKeyOptions;
  /** Sign in with the upstream service instead of pasting a key. Needs `ENCRYPTION_KEY`. */
  oauth?: OAuthOptions;
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
// 10-30s). packages/drizzle/src/client.ts's closeDb() has its own, longer
// CLOSE_TIMEOUT_MS backstop for the same class of problem (PKG-18); the two
// are chosen independently, since a stuck DB client and a stuck HTTP
// keep-alive socket have different acceptable wait times. This is
// intentionally internal and not exposed on `McpHttpOptions`.
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

function headerKey(req: IncomingMessage): string | undefined {
  const header = req.headers['x-api-key'];
  return (Array.isArray(header) ? header[0] : header)?.trim() || undefined;
}

function bearerFrom(req: IncomingMessage): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return bearer?.[1]?.trim() || undefined;
}

const MAX_OAUTH_BODY_BYTES = 64 * 1024;

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_OAUTH_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
  }
  const method = req.method ?? 'GET';
  return new Request(new URL(req.url ?? '/', 'http://localhost'), {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD'
      ? {}
      : { body: Buffer.concat(chunks) })
  });
}

async function sendResponse(
  res: ServerResponse,
  response: Response
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
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
  if (base) mcpPaths.add(base);
  const healthPaths = new Set([`${base}/healthz`, '/healthz']);
  const oauth: OAuthHandler | undefined = options.oauth
    ? createOAuthHandler(options.oauth, base)
    : undefined;

  // The key travels as pass-through authInfo, the SDK's channel from the
  // HTTP request to the per-request factory.
  const mcpHandler = createMcpHandler(
    ({ authInfo, requestInfo }) =>
      options.createMcpServer({
        ...(authInfo ? { apiKey: authInfo.token } : {}),
        ...(authInfo?.extra?.['settings']
          ? {
              oauth: {
                settings: authInfo.extra['settings'] as Record<string, string>
              }
            }
          : {}),
        headers: requestInfo?.headers ?? new Headers()
      }),
    {
      onerror: (error) => {
        logger.error({ err: String(error) }, 'mcp request failed');
      }
    }
  );
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      logger.error({ err: String(error) }, 'mcp request failed');
    }
  });

  async function handleMcp(req: IncomingMessage, res: ServerResponse) {
    // Stateless serving has no session to attach a GET stream or a DELETE to.
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      jsonRpcError(res, 405, 'Method not allowed');
      return;
    }
    if (!options.apiKey && !oauth) {
      await nodeHandler(req, res);
      return;
    }
    const bearer = bearerFrom(req);
    // Tokens this server issued are sealed; an upstream key never looks like one.
    if (oauth && bearer && isEncrypted(bearer) && !headerKey(req)) {
      const grant = oauth.authenticate(bearer);
      if (!grant) {
        res.setHeader('www-authenticate', oauth.challenge('invalid_token'));
        jsonRpcError(res, 401, 'The access token is invalid or expired.');
        return;
      }
      await nodeHandler(
        Object.assign(req, {
          auth: {
            token: grant.accessToken,
            clientId: 'oauth',
            scopes: [],
            extra: { settings: grant.settings }
          }
        }),
        res
      );
      return;
    }
    const apiKey = options.apiKey ? (headerKey(req) ?? bearer) : undefined;
    if (!apiKey) {
      const hint = options.apiKey?.hint ? ` ${options.apiKey.hint}` : '';
      res.setHeader('www-authenticate', oauth ? oauth.challenge() : 'Bearer');
      jsonRpcError(
        res,
        401,
        options.apiKey
          ? `Missing API key: send it in the X-Api-Key header or as Authorization: Bearer <key>.${hint}`
          : 'Sign in to use this server.'
      );
      return;
    }
    await nodeHandler(
      Object.assign(req, {
        auth: { token: apiKey, clientId: 'api-key', scopes: [] }
      }),
      res
    );
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
    if (oauth?.owns(path)) {
      await sendResponse(res, await oauth.handle(await toRequest(req)));
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
    close: async () => {
      await closeHttpServer(http);
      await mcpHandler.close();
    }
  };
}
