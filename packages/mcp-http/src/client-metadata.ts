/** Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document). */
export interface ClientIdMetadataOptions {
  /**
   * Hosts whose metadata documents are fetched, e.g. `['claude.ai']`. Only
   * these can be a `client_id`; it bounds what this server requests.
   */
  trustedHosts: readonly string[];
}

export const DEFAULT_TRUSTED_HOSTS: readonly string[] = ['claude.ai'];

export interface ResolvedClient {
  redirectUris: string[];
  name?: string;
}

export type ClientResolution =
  { ok: true; client: ResolvedClient } | { ok: false; reason: string };

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOCUMENT_BYTES = 16 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 100;
const LOOPBACK = ['127.0.0.1', '[::1]', 'localhost'];

/** A `client_id` that should be resolved as a metadata document rather than a registration. */
export function isClientIdUrl(value: string): boolean {
  return value.startsWith('https://');
}

export function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.hash) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK.includes(url.hostname);
  } catch {
    return false;
  }
}

/** Why a client_id URL is not acceptable, or undefined when it is. */
function urlProblem(
  clientId: string,
  trustedHosts: readonly string[]
): string | undefined {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return 'The client_id is not a URL.';
  }
  // Comparing with the parsed form rejects dot segments, default ports,
  // uppercase hosts and other spellings of the same URL.
  if (
    url.href !== clientId ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname === '/'
  ) {
    return 'The client_id is not a valid metadata document URL.';
  }
  if (!trustedHosts.includes(url.host)) {
    return `Clients from ${url.host} are not accepted here.`;
  }
  return undefined;
}

async function readLimited(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_DOCUMENT_BYTES) return undefined;
  if (!response.body) return '';
  // Without the DOM lib the stream is untyped; fetch bodies are bytes.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseDocument(clientId: string, text: string): ClientResolution {
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error();
    doc = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'The client metadata is not a JSON object.' };
  }
  if (doc['client_id'] !== clientId) {
    return {
      ok: false,
      reason: 'The client metadata names another client_id.'
    };
  }
  const method = doc['token_endpoint_auth_method'];
  // Only public clients: a shared secret cannot be part of a public document.
  if (method !== undefined && method !== 'none') {
    return {
      ok: false,
      reason: 'Only clients with token_endpoint_auth_method none are supported.'
    };
  }
  const grants = doc['grant_types'];
  if (
    grants !== undefined &&
    !(Array.isArray(grants) && grants.includes('authorization_code'))
  ) {
    return {
      ok: false,
      reason: 'The client does not use the authorization code grant.'
    };
  }
  const uris = doc['redirect_uris'];
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    !uris.every(
      (uri): uri is string =>
        typeof uri === 'string' && isAllowedRedirectUri(uri)
    )
  ) {
    return {
      ok: false,
      reason: 'The client metadata has no valid redirect_uris.'
    };
  }
  const name = doc['client_name'];
  return {
    ok: true,
    client: {
      redirectUris: uris,
      ...(typeof name === 'string' ? { name } : {})
    }
  };
}

export function createClientResolver(
  options: ClientIdMetadataOptions,
  fetchImpl: typeof globalThis.fetch
): (clientId: string) => Promise<ClientResolution> {
  const cache = new Map<string, { client: ResolvedClient; expires: number }>();

  return async (clientId) => {
    const problem = urlProblem(clientId, options.trustedHosts);
    if (problem) return { ok: false, reason: problem };

    const now = Date.now();
    const cached = cache.get(clientId);
    if (cached && cached.expires > now)
      return { ok: true, client: cached.client };

    let text: string | undefined;
    try {
      const response = await fetchImpl(clientId, {
        headers: { accept: 'application/json' },
        // A redirect could lead anywhere; the document must live at the URL itself.
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!response.ok) {
        return {
          ok: false,
          reason: `The client metadata could not be fetched (HTTP ${String(response.status)}).`
        };
      }
      text = await readLimited(response);
    } catch {
      return { ok: false, reason: 'The client metadata could not be fetched.' };
    }
    if (text === undefined) {
      return { ok: false, reason: 'The client metadata is too large.' };
    }
    const result = parseDocument(clientId, text);
    if (result.ok) {
      if (cache.size >= CACHE_MAX_ENTRIES) {
        for (const [key, entry] of cache) {
          if (entry.expires <= now) cache.delete(key);
        }
        if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
      }
      cache.set(clientId, {
        client: result.client,
        expires: now + CACHE_TTL_MS
      });
    }
    return result;
  };
}
