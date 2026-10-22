export interface UpstreamTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds; unset when the upstream token does not expire. */
  expiresAt?: number;
}

/** The OAuth provider behind the server, to which this server is a confidential client. */
export interface OAuthUpstream {
  authorizeUrl(params: { redirectUri: string; state: string }): string;
  exchangeCode(params: {
    code: string;
    redirectUri: string;
  }): Promise<UpstreamTokens>;
  refresh?(refreshToken: string): Promise<UpstreamTokens>;
}

export interface OAuth2UpstreamOptions {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: readonly string[];
  fetch?: typeof globalThis.fetch;
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/** A standard authorization code provider that takes its client secret in the request body. */
export function oauth2Upstream(options: OAuth2UpstreamOptions): OAuthUpstream {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  async function token(
    params: Record<string, string>
  ): Promise<UpstreamTokens> {
    const response = await fetchImpl(options.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        ...params
      })
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
      accessToken: body.access_token,
      ...(typeof body.refresh_token === 'string'
        ? { refreshToken: body.refresh_token }
        : {}),
      ...(typeof body.expires_in === 'number'
        ? { expiresAt: Date.now() + body.expires_in * 1000 }
        : {})
    };
  }

  return {
    authorizeUrl({ redirectUri, state }) {
      const url = new URL(options.authorizeUrl);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', options.scopes.join(' '));
      url.searchParams.set('state', state);
      return url.toString();
    },
    exchangeCode: ({ code, redirectUri }) =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }),
    refresh: (refreshToken) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken })
  };
}
