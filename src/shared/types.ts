export type ErrorCode = 'INVALID_REQUEST' | 'INVALID_SLOT' | 'ROUND_NOT_STARTED' | 'ROUND_ENDED' | 'INTERNAL_ERROR' | 'DATABASE_UNAVAILABLE';

export function apiError(code: ErrorCode, message: string) {
  return { code, message, position: null, winner: false };
}
