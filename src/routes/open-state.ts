import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { getSlot } from '../db/slots.js';
import { currentSlot, nextSlot } from '../services/slot-time.js';
import { apiError } from '../shared/types.js';

export function registerOpenState(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/open-state', async (_request, reply) => {
    try {
      let responseTime = new Date();
      let slot = currentSlot(responseTime);
      let row = await getSlot(pool, slot);
      responseTime = new Date();
      if (currentSlot(responseTime).getTime() !== slot.getTime()) {
        slot = currentSlot(responseTime);
        row = await getSlot(pool, slot);
        responseTime = new Date();
      }
      const end = nextSlot(slot);
      const closesAt = row ? new Date(Math.min(row.created_at.getTime() + 10_000, end.getTime())) : null;
      reply.header('Cache-Control', 'public, max-age=0, s-maxage=1');
      return {
        serverTime: responseTime.toISOString(),
        slotAt: slot.toISOString(),
        roundEndsAt: end.toISOString(),
        winnerExists: row !== null,
        registrationOpen: responseTime < end && (!closesAt || responseTime < closesAt),
        registrationClosesAt: closesAt?.toISOString() ?? null
      };
    } catch {
      reply.code(503);
      return apiError('DATABASE_UNAVAILABLE', '데이터베이스를 사용할 수 없습니다.');
    }
  });
}
