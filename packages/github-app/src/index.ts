import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

export type Permission = 'read' | 'write';

export interface GitHubAppConfig {
  /** The App's client ID (`Iv…`); GitHub accepts it as the JWT issuer. */
  clientId: string;
  /** The App's private key, PEM. */
  privateKey: string;
  /** For GitHub Enterprise Server; default `https://api.github.com`. */
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Milliseconds since the epoch; for tests. */
  now?: () => number;
}

export interface TokenRequest {
  /** The organization or user the App is installed on. */
  owner: string;
  /** Repository names without the owner. Omitted: every repository of the installation. */
  repositories?: readonly string[];
  /** Omitted: everything the App was granted. */
  permissions?: Readonly<Record<string, Permission>>;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

export interface GitHubApp {
  /** A JWT for the App's own endpoints, valid for ten minutes. */
  jwt(): string;
  /** An installation token, reused until five minutes before it expires. */
  installationToken(request: TokenRequest): Promise<InstallationToken>;
}

export class GitHubAppError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'GitHubAppError';
  }
}

// GitHub rejects an `iat` ahead of its own clock, so the JWT is backdated.
const CLOCK_SKEW_S = 60;
const JWT_LIFETIME_S = 9 * 60;
const REUSE_MARGIN_MS = 5 * 60_000;

export function createGitHubApp(config: GitHubAppConfig): GitHubApp {
  if (!config.clientId) throw new Error('GitHub App: clientId is required');
  const key: KeyObject = createPrivateKey(config.privateKey);
  const apiUrl = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const fetchFn = config.fetch ?? globalThis.fetch;
  const now = config.now ?? Date.now;
  const installations = new Map<string, number>();
  const tokens = new Map<string, Promise<InstallationToken>>();

  function jwt(): string {
    const iat = Math.floor(now() / 1000) - CLOCK_SKEW_S;
    const header = base64url({ alg: 'RS256', typ: 'JWT' });
    const payload = base64url({
      iat,
      exp: iat + CLOCK_SKEW_S + JWT_LIFETIME_S,
      iss: config.clientId
    });
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(key, 'base64url');
    return `${header}.${payload}.${signature}`;
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchFn(`${apiUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      }
    });
    if (!response.ok) {
      throw new GitHubAppError(
        `GitHub App: ${init.method ?? 'GET'} ${path} returned ${String(response.status)}: ${await errorMessage(response)}`,
        response.status
      );
    }
    return (await response.json()) as T;
  }

  async function installationId(owner: string): Promise<number> {
    const known = installations.get(owner.toLowerCase());
    if (known !== undefined) return known;
    const { id } = await call<{ id: number }>(
      `/orgs/${encodeURIComponent(owner)}/installation`
    ).catch((error: unknown) => {
      // A personal account is not an organization.
      if (error instanceof GitHubAppError && error.status === 404) {
        return call<{ id: number }>(
          `/users/${encodeURIComponent(owner)}/installation`
        );
      }
      throw error;
    });
    installations.set(owner.toLowerCase(), id);
    return id;
  }

  async function mint(request: TokenRequest): Promise<InstallationToken> {
    const id = await installationId(request.owner);
    const body: Record<string, unknown> = {};
    if (request.repositories) body['repositories'] = [...request.repositories];
    if (request.permissions) body['permissions'] = request.permissions;
    const result = await call<{ token: string; expires_at: string }>(
      `/app/installations/${String(id)}/access_tokens`,
      { method: 'POST', body: JSON.stringify(body) }
    );
    return { token: result.token, expiresAt: new Date(result.expires_at) };
  }

  function installationToken(
    request: TokenRequest
  ): Promise<InstallationToken> {
    if (request.repositories?.length === 0) {
      // GitHub reads an empty list as "every repository".
      return Promise.reject(
        new Error('GitHub App: an empty repository list is not a narrowing')
      );
    }
    const key = cacheKey(request);
    const cached = tokens.get(key);
    if (cached) {
      return cached.then((token) =>
        token.expiresAt.getTime() - now() > REUSE_MARGIN_MS
          ? token
          : refresh(key, request)
      );
    }
    return refresh(key, request);
  }

  function refresh(
    key: string,
    request: TokenRequest
  ): Promise<InstallationToken> {
    const pending = mint(request);
    tokens.set(key, pending);
    pending.catch(() => tokens.delete(key));
    return pending;
  }

  return { jwt, installationToken };
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function cacheKey(request: TokenRequest): string {
  const repositories = request.repositories
    ? [...request.repositories].map((r) => r.toLowerCase()).sort()
    : null;
  const permissions = request.permissions
    ? Object.entries(request.permissions).sort(([a], [b]) => a.localeCompare(b))
    : null;
  return JSON.stringify([
    request.owner.toLowerCase(),
    repositories,
    permissions
  ]);
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string'
      ? body.message
      : response.statusText;
  } catch {
    return response.statusText;
  }
}
