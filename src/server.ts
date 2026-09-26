import Fastify from 'fastify';
import { readConfig } from './config/env.js';
import { createPool } from './db/pool.js';
import { registerAttempts } from './routes/attempts.js';
import { registerHealth } from './routes/health.js';
import { registerRound } from './routes/round.js';
import { apiError } from './shared/types.js';

const config = readConfig();
const pool = createPool(config.databaseUrl);
const app = Fastify({ logger: false, bodyLimit: 4096 });

app.setErrorHandler((error, _request, reply) => {
  const details = error as { statusCode?: number; validation?: unknown };
  const isBadRequest = details.statusCode === 400 || details.statusCode === 413 || Boolean(details.validation);
  reply.code(isBadRequest ? 400 : 500).send(isBadRequest
    ? apiError('INVALID_REQUEST', '요청 본문을 확인해 주세요.')
    : apiError('INTERNAL_ERROR', '요청을 처리하지 못했습니다.'));
});
registerHealth(app, pool);
registerRound(app, pool);
registerAttempts(app, pool);
app.addHook('onClose', async () => { await pool.end(); });

try {
  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`HourBoard listening on 127.0.0.1:${config.port}`);
} catch {
  await app.close();
  process.exitCode = 1;
  console.error('Server failed to start');
}
