const BASE = 'https://return-to.invalid';

// Parsed with the URL parser rather than string checks: `/\evil.example` passes
// a `//` check, but the parser reads the backslash as a slash and resolves it
// to https://evil.example.
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/')) return '/';
  try {
    const resolved = new URL(value, BASE);
    if (resolved.origin !== BASE) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}
