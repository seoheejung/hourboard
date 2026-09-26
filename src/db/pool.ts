import pg from 'pg';

export function createPool(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on('error', () => {
    // 유휴 연결 오류 기록
    console.error('PostgreSQL idle connection error');
  });
  return pool;
}
