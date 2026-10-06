import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
