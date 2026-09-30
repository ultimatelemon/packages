export interface CookieOptions {
  httpOnly: true;
  secure: true;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
}

export interface CookieToSet {
  name: string;
  value: string;
  options: CookieOptions;
}

// `__Host-` forces https, path `/` and no Domain, so a sibling subdomain cannot
// plant the cookie. Browsers treat localhost as secure, so it works locally.
export function hostCookieName(prefix: string, name: string): string {
  return `__Host-${prefix}_${name}`;
}

export function cookie(
  name: string,
  value: string,
  maxAge: number
): CookieToSet {
  return {
    name,
    value,
    options: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge
    }
  };
}
