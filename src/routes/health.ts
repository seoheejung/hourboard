import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

export function registerHealth(app: FastifyInstance, pool: pg.Pool) {
  app.get('/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      reply.code(503);
      return { status: 'unavailable' };
    }
  });
}
