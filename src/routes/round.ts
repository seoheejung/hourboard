import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { getSlot } from '../db/slots.js';
import { currentSlot, nextSlot } from '../services/slot-time.js';
import { apiError } from '../shared/types.js';

export function registerRound(app: FastifyInstance, pool: pg.Pool) {
  app.get('/api/round', async (_request, reply) => {
    const now = new Date();
    const slot = currentSlot(now);
    const end = nextSlot(slot);
    try {
      const row = await getSlot(pool, slot);
      const responseTime = new Date();
      const registrationClosesAt = row
        ? new Date(Math.min(row.created_at.getTime() + 10_000, end.getTime()))
        : null;
      return {
        serverTime: responseTime.toISOString(),
        currentSlot: {
          startsAt: slot.toISOString(),
          endsAt: end.toISOString(),
          message: row?.winner_message ?? null,
          attemptCount: row ? Number(row.attempt_count) : null,
          registrationOpen: responseTime < end && (!registrationClosesAt || responseTime < registrationClosesAt),
          registrationClosesAt: registrationClosesAt?.toISOString() ?? null
        },
        nextSlotAt: end.toISOString()
      };
    } catch {
      reply.code(503);
      return apiError('DATABASE_UNAVAILABLE', '데이터베이스를 사용할 수 없습니다.');
    }
  });
}
