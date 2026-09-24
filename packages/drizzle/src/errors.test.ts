import { describe, expect, it } from 'vitest';

import {
  PgErrorCode,
  getPgError,
  isForeignKeyViolation,
  isPgError,
  isUniqueViolation
} from './errors.js';

function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('pg'), { code, constraint });
}

function wrapped(cause: unknown, depth = 1): unknown {
  let error: unknown = cause;
  for (let i = 0; i < depth; i += 1) {
    error = new Error('Failed query', { cause: error });
  }
  return error;
}

describe('getPgError', () => {
  it('reads the fields of a pg error', () => {
    const error = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
      detail: 'Key (email)=(a@b.nl) already exists.'
    });
    expect(getPgError(error)).toEqual({
      code: '23505',
      constraint: 'users_email_key',
      table: 'users',
      column: undefined,
      detail: 'Key (email)=(a@b.nl) already exists.'
    });
  });

  it('finds the pg error inside the cause chain Drizzle adds', () => {
    expect(getPgError(wrapped(pgError('23503'), 3))?.code).toBe('23503');
  });

  it('gives up after five levels', () => {
    expect(getPgError(wrapped(pgError('23505'), 5))).toBeNull();
  });

  it('ignores Node error codes that are not a SQLSTATE', () => {
    const refused = Object.assign(new Error('connect'), {
      code: 'ECONNREFUSED'
    });
    expect(getPgError(refused)).toBeNull();
  });

  it('returns null for anything that is not an object', () => {
    expect(getPgError(null)).toBeNull();
    expect(getPgError('23505')).toBeNull();
    expect(getPgError(undefined)).toBeNull();
  });
});

describe('isPgError', () => {
  it('matches the code, and the constraint when one is given', () => {
    const error = wrapped(pgError('23514', 'price_positive'));
    expect(isPgError(error, PgErrorCode.CheckViolation)).toBe(true);
    expect(isPgError(error, PgErrorCode.CheckViolation, 'price_positive')).toBe(
      true
    );
    expect(isPgError(error, PgErrorCode.CheckViolation, 'other')).toBe(false);
    expect(isPgError(error, PgErrorCode.UniqueViolation)).toBe(false);
  });
});

describe('isUniqueViolation and isForeignKeyViolation', () => {
  it('tell the two apart', () => {
    const unique = wrapped(pgError('23505', 'users_email_key'));
    const foreignKey = wrapped(pgError('23503', 'orders_user_id_fkey'));

    expect(isUniqueViolation(unique)).toBe(true);
    expect(isUniqueViolation(unique, 'users_email_key')).toBe(true);
    expect(isUniqueViolation(unique, 'users_username_key')).toBe(false);
    expect(isUniqueViolation(foreignKey)).toBe(false);

    expect(isForeignKeyViolation(foreignKey)).toBe(true);
    expect(isForeignKeyViolation(foreignKey, 'orders_user_id_fkey')).toBe(true);
    expect(isForeignKeyViolation(unique)).toBe(false);
  });
});
