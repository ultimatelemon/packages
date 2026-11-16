import {
  requestTokens,
  UpstreamError,
  type OAuthUpstream,
  type TokenResponse,
  type UpstreamTokens
} from './upstream.js';

export interface OidcUpstreamOptions {
  /** Issuer URL, e.g. `https://id.example.com`. Must be https. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Default `['openid']`. Add `offline_access` for an upstream refresh token. */
  scopes?: readonly string[];
  /** How the client secret reaches the token endpoint. Default `client_secret_post`. */
  tokenEndpointAuthMethod?: 'client_secret_post' | 'client_secret_basic';
  fetch?: typeof globalThis.fetch;
}

interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

const CLOCK_SKEW_SECONDS = 60;

function httpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function decodeClaims(idToken: string): Record<string, unknown> {
  const payload = idToken.split('.')[1];
  if (!payload) throw new UpstreamError('The id_token is not a JWT.');
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );
    if (typeof claims !== 'object' || claims === null) throw new Error();
    return claims as Record<string, unknown>;
  } catch {
    throw new UpstreamError('The id_token payload is not JSON.');
  }
}

/**
 * An OpenID Connect provider such as Zitadel. Tokens carry the `sub` of whoever
 * signed in as `subject`, which reaches the MCP server as `oauth.subject`.
 */
export function oidcUpstream(options: OidcUpstreamOptions): OAuthUpstream {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const issuer = options.issuer.replace(/\/+$/, '');
  const scopes = options.scopes ?? ['openid'];
  const basic = options.tokenEndpointAuthMethod === 'client_secret_basic';
  if (!httpsUrl(issuer)) {
    throw new UpstreamError('The OIDC issuer must be an https URL.');
  }
  if (!scopes.includes('openid')) {
    throw new UpstreamError('The OIDC scopes must include openid.');
  }

  let discovery: Promise<Discovery> | undefined;

  function discover(): Promise<Discovery> {
    discovery ??= (async () => {
      const response = await fetchImpl(
        `${issuer}/.well-known/openid-configuration`,
        { headers: { accept: 'application/json' } }
      );
      if (!response.ok) {
        throw new UpstreamError(
          `OIDC discovery failed: HTTP ${String(response.status)}`
        );
      }
      const body = (await response.json()) as Record<string, unknown>;
      // The issuer check is what lets the id_token be trusted without its
      // signature: it arrives over TLS straight from this issuer's endpoint.
      if (body['issuer'] !== issuer) {
        throw new UpstreamError('OIDC discovery returned another issuer.');
      }
      const authorizationEndpoint = body['authorization_endpoint'];
      const tokenEndpoint = body['token_endpoint'];
      if (!httpsUrl(authorizationEndpoint) || !httpsUrl(tokenEndpoint)) {
        throw new UpstreamError('OIDC discovery lacks https endpoints.');
      }
      return { issuer, authorizationEndpoint, tokenEndpoint };
    })().catch((error: unknown) => {
      // A failed discovery must not stick; the next sign-in retries.
      discovery = undefined;
      throw error;
    });
    return discovery;
  }

  /**
   * OIDC Core 3.1.3.7: an id_token received straight from the token endpoint
   * over TLS may be trusted on TLS instead of its signature. The claims that
   * bind it to this issuer, this client and now are still checked.
   */
  function subjectOf(body: TokenResponse, required: boolean) {
    if (typeof body.id_token !== 'string') {
      if (required) throw new UpstreamError('The provider sent no id_token.');
      return undefined;
    }
    const claims = decodeClaims(body.id_token);
    const aud = claims['aud'];
    const audiences = Array.isArray(aud) ? aud : [aud];
    const now = Date.now() / 1000;
    if (claims['iss'] !== issuer) {
      throw new UpstreamError('The id_token comes from another issuer.');
    }
    if (!audiences.includes(options.clientId)) {
      throw new UpstreamError('The id_token is meant for another client.');
    }
    if (audiences.length > 1 && claims['azp'] !== options.clientId) {
      throw new UpstreamError('The id_token was issued to another client.');
    }
    const exp = claims['exp'];
    if (typeof exp !== 'number' || exp + CLOCK_SKEW_SECONDS < now) {
      throw new UpstreamError('The id_token has expired.');
    }
    const sub = claims['sub'];
    if (typeof sub !== 'string' || sub === '') {
      throw new UpstreamError('The id_token names no subject.');
    }
    return sub;
  }

  async function token(
    params: Record<string, string>,
    requireIdToken: boolean
  ): Promise<UpstreamTokens> {
    const { tokenEndpoint } = await discover();
    const credentials = basic
      ? {
          authorization: `Basic ${Buffer.from(
            `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`
          ).toString('base64')}`
        }
      : undefined;
    const { tokens, body } = await requestTokens(
      fetchImpl,
      tokenEndpoint,
      basic
        ? params
        : {
            client_id: options.clientId,
            client_secret: options.clientSecret,
            ...params
          },
      credentials
    );
    const subject = subjectOf(body, requireIdToken);
    return { ...tokens, ...(subject !== undefined ? { subject } : {}) };
  }

  return {
    async authorizeUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL((await discover()).authorizationEndpoint);
      url.searchParams.set('client_id', options.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    exchangeCode: ({ code, redirectUri, codeVerifier }) =>
      token(
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier
        },
        true
      ),
    refresh: (refreshToken) =>
      token({ grant_type: 'refresh_token', refresh_token: refreshToken }, false)
  };
}
