import type pg from 'pg';

export async function getSlot(pool: pg.Pool, slotAt: Date) {
  const result = await pool.query<{ winner_message: string; attempt_count: string }>(
    'SELECT winner_message, attempt_count FROM hour_slots WHERE slot_start = $1', [slotAt]
  );
  return result.rows[0] ?? null;
}

export async function registerAttempt(pool: pg.Pool, slotAt: Date, message: string) {
  const result = await pool.query<{ attempt_count: string }>(`
    INSERT INTO hour_slots (slot_start, winner_message, attempt_count)
    VALUES ($1, $2, 1)
    ON CONFLICT (slot_start)
    DO UPDATE SET attempt_count = hour_slots.attempt_count + 1
    RETURNING attempt_count
  `, [slotAt, message]);
  if (!result.rows[0]) throw new Error('UPSERT returned no row');
  return Number(result.rows[0].attempt_count);
}
