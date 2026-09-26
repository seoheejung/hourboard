import type pg from 'pg';

export async function getSlot(pool: pg.Pool, slotAt: Date) {
  const result = await pool.query<{ winner_message: string; attempt_count: string; created_at: Date }>(
    'SELECT winner_message, attempt_count, created_at FROM hour_slots WHERE slot_start = $1', [slotAt]
  );
  return result.rows[0] ?? null;
}

export async function registerAttempt(pool: pg.Pool, slotAt: Date, message: string) {
  const result = await pool.query<{ attempt_count: string; created_at: Date }>(`
    WITH db_time AS MATERIALIZED (SELECT clock_timestamp() AS at)
    INSERT INTO hour_slots (slot_start, winner_message, attempt_count, created_at)
    SELECT $1, $2, 1, db_time.at
    FROM db_time
    WHERE db_time.at >= $1::timestamptz
      AND db_time.at < $1::timestamptz + INTERVAL '1 hour'
    ON CONFLICT (slot_start)
    DO UPDATE SET attempt_count = hour_slots.attempt_count + 1
    WHERE clock_timestamp() < LEAST(
      hour_slots.created_at + INTERVAL '10 seconds',
      hour_slots.slot_start + INTERVAL '1 hour'
    )
    RETURNING attempt_count, created_at
  `, [slotAt, message]);
  const row = result.rows[0];
  if (!row) return null;
  return { position: Number(row.attempt_count), firstRegisteredAt: row.created_at };
}
