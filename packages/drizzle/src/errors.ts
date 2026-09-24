export const PgErrorCode = {
  NotNullViolation: '23502',
  ForeignKeyViolation: '23503',
  UniqueViolation: '23505',
  CheckViolation: '23514'
} as const;

export interface PgError {
  code: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
}

const MAX_CAUSE_DEPTH = 5;
const SQLSTATE = /^[0-9A-Z]{5}$/;

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Drizzle wraps the pg error in `cause`, so walk that chain. Only a
// five-character SQLSTATE counts: Node's own errors also carry a `code`
// (ECONNREFUSED), and those are not database errors.
export function getPgError(error: unknown): PgError | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      SQLSTATE.test(current.code)
    ) {
      const fields = current as Record<string, unknown>;
      return {
        code: current.code,
        constraint: optionalString(fields.constraint),
        table: optionalString(fields.table),
        column: optionalString(fields.column),
        detail: optionalString(fields.detail)
      };
    }
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

export function isPgError(
  error: unknown,
  code: string,
  constraint?: string
): boolean {
  const pgError = getPgError(error);
  if (pgError?.code !== code) return false;
  return constraint === undefined || pgError.constraint === constraint;
}

export function isUniqueViolation(
  error: unknown,
  constraint?: string
): boolean {
  return isPgError(error, PgErrorCode.UniqueViolation, constraint);
}

export function isForeignKeyViolation(
  error: unknown,
  constraint?: string
): boolean {
  return isPgError(error, PgErrorCode.ForeignKeyViolation, constraint);
}
