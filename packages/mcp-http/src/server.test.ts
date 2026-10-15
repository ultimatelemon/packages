import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { startMcpHttpServer, type McpHttpServer } from './index.js';

let created = 0;
let ready = true;
const errors: unknown[] = [];

function createMcpServer() {
  created++;
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  server.registerTool(
    'echo',
    { description: 'Echoes', inputSchema: {} },
    () => ({ content: [{ type: 'text', text: 'pong' }] })
  );
  return server;
}

let http: McpHttpServer;
let base: string;

beforeAll(async () => {
  http = await startMcpHttpServer({
    createMcpServer,
    port: 0,
    host: '127.0.0.1',
    basePath: 'tools/',
    health: () => ready,
    logger: { error: (obj) => errors.push(obj) }
  });
  base = `http://127.0.0.1:${String(http.port)}`;
});

afterAll(() => http.close());

describe('startMcpHttpServer', () => {
  it('reports the bound port and the URL under the base path', () => {
    expect(http.port).toBeGreaterThan(0);
    expect(http.url).toBe(`${base}/tools/mcp`);
  });

  it('serves MCP to a real client, one server per request', async () => {
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
    const before = created;
    const result = await client.callTool({ name: 'echo', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(created).toBe(before + 1);
    await client.close();
  });

  it('also answers on /mcp without the base path', async () => {
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`))
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo']);
    await client.close();
  });

  it('rejects GET and DELETE with 405 in stateless mode', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(http.url, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('reports health from the callback', async () => {
    expect((await fetch(`${base}/tools/healthz`)).status).toBe(200);
    ready = false;
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    ready = true;
  });

  it('answers unknown paths with 404', async () => {
    expect((await fetch(`${base}/elsewhere`)).status).toBe(404);
  });
});

// A separate server instance with its own `guardErrors` array: forcing close()
// rejections here must not pollute the assertions the tests above make on the
// shared `http` instance and its `errors` array.
describe('startMcpHttpServer - close handler rejection guard', () => {
  let guardHttp: McpHttpServer;
  let guardErrors: Array<{ err: string; msg?: string }>;

  function createGuardMcpServer() {
    const server = new McpServer({ name: 'guard-test', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echoes', inputSchema: {} },
      () => ({ content: [{ type: 'text', text: 'pong' }] })
    );
    return server;
  }

  beforeAll(async () => {
    guardHttp = await startMcpHttpServer({
      createMcpServer: createGuardMcpServer,
      port: 0,
      host: '127.0.0.1',
      logger: {
        error: (obj) => guardErrors.push(obj as { err: string; msg?: string })
      }
    });
  });

  beforeEach(() => {
    guardErrors = [];
  });

  afterAll(() => guardHttp.close());

  async function roundTrip() {
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(guardHttp.url))
    );
    const result = await client.callTool({ name: 'echo', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    await client.close();
  }

  it('logs a transport.close() rejection, still calls server.close(), and keeps serving requests', async () => {
    // Force transport.close() - called unconditionally from the response's
    // 'close' handler - to reject exactly once, simulating a client abort or
    // a double-close. The `.catch()` guard on this call must log the
    // rejection rather than let it escape as an unhandled rejection, which
    // under Node's default --unhandled-rejections=throw would crash the
    // process.
    const transportCloseSpy = vi
      .spyOn(StreamableHTTPServerTransport.prototype, 'close')
      .mockRejectedValueOnce(new Error('boom'));
    // Spy (without overriding) on server.close() to prove it still runs even
    // though transport.close() rejected first - the two calls must not share
    // a try/catch that would short-circuit the second one.
    const serverCloseSpy = vi.spyOn(McpServer.prototype, 'close');

    try {
      await roundTrip();

      // The response's 'close' event (which drives the close() calls under
      // test) fires asynchronously after the request completes; wait for the
      // rejection to be handled and logged.
      await vi.waitFor(() => {
        expect(guardErrors).toContainEqual(
          expect.objectContaining({ err: 'Error: boom' })
        );
      });
      expect(serverCloseSpy).toHaveBeenCalled();
    } finally {
      transportCloseSpy.mockRestore();
      serverCloseSpy.mockRestore();
    }

    // If the rejection above had crashed the process (or otherwise left the
    // server in a broken state), this request would hang or fail. A
    // successful round trip proves the server instance is still alive and
    // usable after the earlier close() rejection.
    await roundTrip();
  });

  it('logs a server.close() rejection without affecting the transport close', async () => {
    const serverCloseSpy = vi
      .spyOn(McpServer.prototype, 'close')
      .mockRejectedValueOnce(new Error('kaboom'));

    try {
      await roundTrip();

      await vi.waitFor(() => {
        expect(guardErrors).toContainEqual(
          expect.objectContaining({ err: 'Error: kaboom' })
        );
      });
    } finally {
      serverCloseSpy.mockRestore();
    }

    // Same proof as above: the server instance is still usable afterwards.
    await roundTrip();
  });
});

// PKG-10: close() used to call closeIdleConnections() exactly once,
// synchronously, right when close() was invoked. A keep-alive connection
// that was still processing a request at that exact moment - and only
// became idle afterwards - was never swept again. Node's own default
// `keepAliveTimeout` (also 5000ms) would eventually clean such a socket up,
// but only *after* it went idle, which lands well past this package's own
// force-close budget (FORCE_CLOSE_TIMEOUT_MS = 5000ms, measured from the
// moment close() is called). Each test here starts its own server so the
// slow/close-while-in-flight timing of one test can't bleed into another.
describe('startMcpHttpServer - keep-alive connections must not block close()', () => {
  function createDelayedEchoServer(delayMs: number) {
    return () => {
      const server = new McpServer({
        name: 'keep-alive-test',
        version: '1.0.0'
      });
      server.registerTool(
        'slow-echo',
        { description: 'Echoes after an artificial delay', inputSchema: {} },
        async () => {
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
          return { content: [{ type: 'text', text: 'pong' }] };
        }
      );
      return server;
    };
  }

  function buildKeepAlivePostRequest(port: number, body: string): string {
    return (
      `POST /mcp HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${String(port)}\r\n` +
      `Content-Type: application/json\r\n` +
      `Accept: application/json, text/event-stream\r\n` +
      `Connection: keep-alive\r\n` +
      `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n` +
      body
    );
  }

  // Tries a brand-new raw TCP connection to `port` and resolves with
  // 'connected' or the socket error code (e.g. 'ECONNREFUSED'), whichever
  // happens first, with a generous fallback so this never hangs the suite.
  // Clears its own timer and destroys the probe on every path so it never
  // leaks a handle into the next test.
  async function tryConnect(port: number): Promise<string> {
    return new Promise<string>((resolve) => {
      const probe = net.connect(port, '127.0.0.1');
      const fallback = setTimeout(() => {
        probe.destroy();
        resolve('timeout');
      }, 2000).unref();
      probe.once('connect', () => {
        clearTimeout(fallback);
        probe.destroy();
        resolve('connected');
      });
      probe.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(fallback);
        resolve(err.code ?? 'error');
      });
    });
  }

  it('resolves close() within the force-close budget even when a keep-alive connection only goes idle after the first idle sweep - and then refuses new connections', async () => {
    const srv = await startMcpHttpServer({
      createMcpServer: createDelayedEchoServer(300),
      port: 0,
      host: '127.0.0.1',
      logger: { error: () => {} }
    });

    const socket = net.connect(srv.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });

    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
    });

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slow-echo', arguments: {} }
    });
    socket.write(buildKeepAlivePostRequest(srv.port, body));

    try {
      // Call close() immediately after writing the request bytes: the
      // handler is still awaiting the tool's artificial 300ms delay, so the
      // connection is NOT idle yet when close()'s first idle sweep runs. It
      // only becomes idle once the response has been written - strictly
      // after that sweep, no follow-up request, no socket.end() - which is
      // exactly the scenario this card fixes.
      const closeStartedAt = Date.now();
      await srv.close();
      const closeElapsedMs = Date.now() - closeStartedAt;

      // Settled via the repeated idle sweep, not the force-close fallback:
      // the connection goes idle ~1s after the tool's 300ms delay (once the
      // response is flushed), well before FORCE_CLOSE_TIMEOUT_MS (5000ms).
      // Without the fix this consistently lands past 6000ms instead (Node's
      // unrelated default keepAliveTimeout eventually destroying the
      // forgotten socket), so 2000ms sharply separates "fixed" from "buggy"
      // while leaving ample CI scheduling slack over the ~0.5s fixed case.
      expect(closeElapsedMs).toBeLessThan(2000);

      // The request that was in flight when close() was called must still
      // have been allowed to finish and send its response.
      expect(received).toContain('"text":"pong"');

      // Once close() has settled, the port must no longer accept new TCP
      // connections.
      expect(await tryConnect(srv.port)).not.toBe('connected');
    } finally {
      socket.destroy();
    }
  }, 10_000);

  it('resolves close() via the force-close fallback when a connection never goes idle at all', async () => {
    const srv = await startMcpHttpServer({
      createMcpServer: createDelayedEchoServer(0),
      port: 0,
      host: '127.0.0.1',
      logger: { error: () => {} }
    });

    // Send a request that announces a body larger than what is ever
    // written, then stop: the server is left waiting mid-request forever,
    // so the socket never completes a request and never goes idle. No
    // repeated `closeIdleConnections()` sweep can ever touch it - only the
    // `closeAllConnections()` fallback, fired after FORCE_CLOSE_TIMEOUT_MS,
    // can make `close()` settle for this connection.
    const socket = net.connect(srv.port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });

    try {
      socket.write(
        `POST /mcp HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${String(srv.port)}\r\n` +
          `Content-Type: application/json\r\n` +
          `Accept: application/json, text/event-stream\r\n` +
          `Connection: keep-alive\r\n` +
          `Content-Length: 500\r\n\r\n` +
          `{"incomplete`
      );

      const closeStartedAt = Date.now();
      await srv.close();
      const closeElapsedMs = Date.now() - closeStartedAt;

      // Must still settle - the whole point of the fix - but only once the
      // force-close fallback fires, i.e. close to FORCE_CLOSE_TIMEOUT_MS
      // (5000ms), not near-instantly via the idle sweep. A regression that
      // silently drops the force-close timer (while keeping the idle
      // sweep) would leave this hanging well past the test timeout
      // instead.
      expect(closeElapsedMs).toBeGreaterThanOrEqual(4500);
      expect(closeElapsedMs).toBeLessThan(6000);

      // Once close() has settled, the port must no longer accept new TCP
      // connections.
      expect(await tryConnect(srv.port)).not.toBe('connected');
    } finally {
      socket.destroy();
    }
  }, 10_000);

  it('resolves close() quickly when there are no open connections (no fixed delay is always awaited)', async () => {
    const srv = await startMcpHttpServer({
      createMcpServer: createDelayedEchoServer(0),
      port: 0,
      host: '127.0.0.1',
      logger: { error: () => {} }
    });

    const startedAt = Date.now();
    await srv.close();
    const elapsedMs = Date.now() - startedAt;

    // A regression that always sleeps out (part of) the force-close budget,
    // even with nothing to force-close, must fail this assertion.
    expect(elapsedMs).toBeLessThan(500);
  });

  it('lets a request already in flight when close() is called finish normally and receive its response', async () => {
    const srv = await startMcpHttpServer({
      createMcpServer: createDelayedEchoServer(300),
      port: 0,
      host: '127.0.0.1',
      logger: { error: () => {} }
    });

    const client = new Client({ name: 'c', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(srv.url)));

    const callPromise = client.callTool({ name: 'slow-echo', arguments: {} });

    // Give the request time to actually reach the server (TCP connect +
    // headers sent) before close() runs, so it is genuinely in flight
    // rather than merely queued client-side.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const closeStartedAt = Date.now();
    const closePromise = srv.close();

    // The call must resolve with the real tool result, not be aborted or
    // rejected because the server started shutting down underneath it.
    const result = await callPromise;
    expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);

    await closePromise;
    // Settles via the idle sweep shortly after the response is flushed
    // (well under a second with the fix); without it, this client's
    // connection would similarly outlive 2000ms as it keeps the server
    // waiting on Node's own default keepAliveTimeout.
    expect(Date.now() - closeStartedAt).toBeLessThan(2000);

    await client.close();
  }, 10_000);
});
