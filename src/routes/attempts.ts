import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { registerAttempt } from '../db/slots.js';
import { attemptBodySchema } from '../schemas/api.js';
import { nextSlot, parseSlot } from '../services/slot-time.js';
import { apiError } from '../shared/types.js';

export function registerAttempts(app: FastifyInstance, pool: pg.Pool) {
  app.post<{ Body: { slotAt: string; message: string } }>(
    '/api/attempts', { schema: { body: attemptBodySchema } },
    async (request, reply) => {
      const slot = parseSlot(request.body.slotAt);
      if (!slot) {
        reply.code(400);
        return apiError('INVALID_SLOT', '정각의 UTC 슬롯을 지정해 주세요.');
      }
      const message = request.body.message.trim();
      if (!message || Array.from(message).length > 120 || /[\r\n\u2028\u2029]/u.test(message)) {
        reply.code(400);
        return apiError('INVALID_REQUEST', '문구는 1~120자여야 합니다.');
      }
      const now = Date.now();
      if (now < slot.getTime()) {
        reply.code(425);
        return apiError('ROUND_NOT_STARTED', '아직 시작하지 않은 Round입니다.');
      }
      if (now >= nextSlot(slot).getTime()) {
        reply.code(409);
        return apiError('ROUND_ENDED', '이미 종료된 Round입니다.');
      }
      try {
        const attempt = await registerAttempt(pool, slot, message);
        if (!attempt) {
          const currentTime = Date.now();
          if (currentTime >= nextSlot(slot).getTime()) {
            reply.code(409);
            return apiError('ROUND_ENDED', '이미 종료된 Round입니다.');
          }
          reply.code(409);
          return apiError('REGISTRATION_CLOSED', '이번 Round의 등록이 마감되었습니다.');
        }
        const position = attempt.position;
        const winner = position === 1;
        const registrationClosesAt = new Date(Math.min(attempt.firstRegisteredAt.getTime() + 10_000, nextSlot(slot).getTime()));
        return {
          slotAt: slot.toISOString(),
          code: winner ? 'WINNER' : 'RANKED',
          message: winner
            ? '가장 먼저 등록하셨습니다. 작성하신 문구를 다음 정각까지 띄워드립니다.'
            : `${position}번째로 등록하셨습니다.`,
          position,
          winner,
          registrationClosesAt: registrationClosesAt.toISOString()
        };
      } catch {
        reply.code(503);
        return apiError('DATABASE_UNAVAILABLE', '등록 결과를 확인하지 못했습니다.');
      }
    }
  );
}
