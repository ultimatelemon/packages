import { jwtVerify, SignJWT } from 'jose';

export interface Session {
  sub: string;
  email: string;
  name: string | null;
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
  session: Session,
  keys: SessionKeys,
  now: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  return new SignJWT({ email: session.email, name: session.name })
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
    if (!payload.sub || typeof email !== 'string' || !email) return null;
    return {
      sub: payload.sub,
      email,
      name: typeof name === 'string' && name ? name : null
    };
  } catch {
    return null;
  }
}
