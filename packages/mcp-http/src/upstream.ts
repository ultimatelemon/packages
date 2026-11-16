export interface UpstreamTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds; unset when the upstream token does not expire. */
  expiresAt?: number;
  /** Who signed in, when the upstream says so (the OIDC `sub`). */
  subject?: string;
}

/** The OAuth provider behind the server, to which this server is a confidential client. */
export interface OAuthUpstream {
  /** `codeChallenge` is an S256 PKCE challenge; send it when the upstream supports PKCE. */
  authorizeUrl(params: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string | Promise<string>;
  /** `codeVerifier` belongs to the `codeChallenge` of the authorize request. */
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<UpstreamTokens>;
  refresh?(refreshToken: string): Promise<UpstreamTokens>;
}

export interface OAuth2UpstreamOptions {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  /** Send a PKCE challenge and verifier. Default false, for providers that reject them. */
  pkce?: boolean;
  fetch?: typeof globalThis.fetch;
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** Posts a form to a token endpoint; throws an `UpstreamError` unless it returns an access token. */
export async function requestTokens(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  params: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<{ tokens: UpstreamTokens; body: TokenResponse }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...headers
    },
    body: new URLSearchParams(params)
  });
  let body: TokenResponse = {};
  try {
    body = (await response.json()) as TokenResponse;
  } catch {
    // Handled below as a response without an access token.
  }
  if (!response.ok || typeof body.access_token !== 'string') {
    const reason =
      typeof body.error_description === 'string'
        ? body.error_description
        : typeof body.error === 'string'
          ? body.error
          : `HTTP ${String(response.status)}`;
    throw new UpstreamError(`Token request failed: ${reason}`);
  }
  return {
    tokens: {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string'
        ? { refreshToken: body.refresh_token }
        : {}),
      ...(typeof body.expires_in === 'number'
        ? { expiresAt: Date.now() + body.expires_in * 1000 }
        : {})
    },
    body
  };
}

/** A standard authorization code provider that takes its client secret in the request body. */
export function oauth2Upstream(options: OAuth2UpstreamOptions): OAuthUpstream {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function token(
    params: Record<string, string>
  ): Promise<UpstreamTokens> {
    const { tokens } = await requestTokens(fetchImpl, options.tokenUrl, {
      client_id: options.clientId,
      client_secret: options.clientSecret,
      ...params
    });
    return tokens;
  }

  return {
    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(options.authorizeUrl);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', options.scopes.join(' '));
      url.searchParams.set('state', state);
      if (options.pkce) {
        url.searchParams.set('code_challenge', codeChallenge);
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url.toString();
    },
    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        ...(options.pkce ? { code_verifier: codeVerifier } : {})
      }),
    refresh: (refreshToken) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken })
  };
}
