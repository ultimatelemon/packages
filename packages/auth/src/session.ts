import { jwtVerify, SignJWT } from 'jose';

export interface Session {
  sub: string;
  email: string;
  name: string | null;
  // When the user last entered credentials at the identity provider, in
  // seconds. With single sign-on this can be older than the session itself.
  authTime: number;
}

export interface SessionKeys {
  secret: string;
  audience: string;
  maxAgeSeconds: number;
}

const MIN_SECRET_LENGTH = 32;

function key(secret: string): Uint8Array {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new RangeError(
      `session secret must be at least ${MIN_SECRET_LENGTH} characters`
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(
  session: Omit<Session, 'authTime'> & { authTime?: number },
  keys: SessionKeys,
  now: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  return new SignJWT({
    email: session.email,
    name: session.name,
    auth_time: session.authTime ?? now
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(session.sub)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + keys.maxAgeSeconds)
    .setIssuer(keys.audience)
    .setAudience(keys.audience)
    .sign(key(keys.secret));
}

export async function verifySession(
  token: string | null | undefined,
  keys: SessionKeys
): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(keys.secret), {
      issuer: keys.audience,
      audience: keys.audience,
      algorithms: ['HS256']
    });
    const email = payload['email'];
    const name = payload['name'];
    const authTime = payload['auth_time'];
    if (!payload.sub || typeof email !== 'string' || !email) return null;
    return {
      sub: payload.sub,
      email,
      name: typeof name === 'string' && name ? name : null,
      // Sessions signed by 1.0.0 have no auth_time; their iat is the login.
      authTime: typeof authTime === 'number' ? authTime : (payload.iat ?? 0)
    };
  } catch {
    return null;
  }
}
