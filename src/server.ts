import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { readConfig } from './config/env.js';
import { createPool } from './db/pool.js';
import { registerAttempts } from './routes/attempts.js';
import { registerHealth } from './routes/health.js';
import { registerOpenState } from './routes/open-state.js';
import { registerRound } from './routes/round.js';
import { apiError } from './shared/types.js';

const config = readConfig();
const pool = createPool(config.databaseUrl);
const app = Fastify({
  logger: false,
  bodyLimit: 4096,
  ajv: { customOptions: { coerceTypes: false, removeAdditional: false } }
});

app.setErrorHandler((error, _request, reply) => {
  const details = error as { statusCode?: number; validation?: unknown };
  const isBadRequest = details.statusCode === 400 || details.statusCode === 413 || Boolean(details.validation);
  reply.code(isBadRequest ? 400 : 500).send(isBadRequest
    ? apiError('INVALID_REQUEST', '요청 본문을 확인해 주세요.')
    : apiError('INTERNAL_ERROR', '요청을 처리하지 못했습니다.'));
});
registerHealth(app, pool);
registerRound(app, pool);
registerOpenState(app, pool);
registerAttempts(app, pool);
await app.register(fastifyStatic, { root: join(process.cwd(), 'public'), prefix: '/' });
app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) {
    return reply.code(404).send({ code: 'NOT_FOUND', message: 'API 경로를 찾을 수 없습니다.', position: null, winner: false });
  }
  return reply.code(404).sendFile('404.html');
});
app.addHook('onClose', async () => { await pool.end(); });

try {
  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`HourBoard listening on 127.0.0.1:${config.port}`);
} catch {
  await app.close();
  process.exitCode = 1;
  console.error('Server failed to start');
}
