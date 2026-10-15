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
