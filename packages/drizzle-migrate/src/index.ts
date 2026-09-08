import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';

export interface RunMigrationsOptions {
  connectionString?: string;
  migrationsFolder?: string;
  lockKey?: bigint | number | string;
  lockTimeoutMs?: number;
  logger?: (message: string) => void;
}

const DEFAULT_LOCK_KEY = 4178233900n;
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MIGRATIONS_FOLDER = './drizzle';

export async function runMigrations(
  options: RunMigrationsOptions = {}
): Promise<void> {
  const {
    connectionString = process.env.DATABASE_URL,
    migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
    lockKey = DEFAULT_LOCK_KEY,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    logger = console.info
  } = options;

  if (!connectionString) {
    throw new Error('DATABASE_URL is missing');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`set lock_timeout = ${lockTimeoutMs}`);
    await client.query('select pg_advisory_lock($1::bigint)', [
      lockKey.toString()
    ]);
    await migrate(drizzle(client), { migrationsFolder });
    logger('Migrations applied');
  } finally {
    await client.end();
  }
}

export async function runMigrationsCli(
  options: RunMigrationsOptions = {}
): Promise<never> {
  try {
    await runMigrations(options);
    process.exit(0);
  } catch (error: unknown) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}
