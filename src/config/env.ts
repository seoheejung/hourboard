export function readConfig() {
  const { NODE_ENV, PORT, DATABASE_URL } = process.env;
  if (!NODE_ENV || !['development', 'test', 'production'].includes(NODE_ENV)) {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  const port = Number(PORT);
  if (!PORT || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  if (!DATABASE_URL || !/^postgres(ql)?:\/\//.test(DATABASE_URL)) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  return { nodeEnv: NODE_ENV, port, databaseUrl: DATABASE_URL };
}
