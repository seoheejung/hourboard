import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

export function readConfig() {
  if (process.env.NODE_ENV !== 'production' &&
      (!process.env.NODE_ENV || !process.env.PORT || !process.env.DATABASE_URL) &&
      existsSync('.env')) {
    loadEnvFile();
  }
  const { NODE_ENV, PORT, DATABASE_URL, POSTGRES_PASSWORD,
    DATABASE_HOST, DATABASE_USER, DATABASE_NAME } = process.env;
  if (!NODE_ENV || !['development', 'test', 'production'].includes(NODE_ENV)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  const port = Number(PORT);
  if (!PORT || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  if (DATABASE_URL && POSTGRES_PASSWORD) {
    throw new Error('Set DATABASE_URL or POSTGRES_PASSWORD, not both');
  }
  let databaseUrl = DATABASE_URL;
  if (!databaseUrl && POSTGRES_PASSWORD) {
    if (!DATABASE_HOST || !DATABASE_USER || !DATABASE_NAME) {
      throw new Error('DATABASE_HOST, DATABASE_USER, and DATABASE_NAME are required with POSTGRES_PASSWORD');
    }
    const url = new URL('postgresql://localhost');
    url.hostname = DATABASE_HOST;
    url.username = DATABASE_USER;
    url.password = POSTGRES_PASSWORD;
    url.pathname = `/${DATABASE_NAME}`;
    databaseUrl = url.toString();
  }
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  return { nodeEnv: NODE_ENV, port, databaseUrl };
}
