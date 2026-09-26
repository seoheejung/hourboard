import { readFile } from 'node:fs/promises';
import { readConfig } from '../config/env.js';
import { createPool } from './pool.js';

const config = readConfig();
const pool = createPool(config.databaseUrl);
try {
  const sql = await readFile(new URL('../../db/migrations/001_create_hour_slots.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('Migration 001 complete');
} finally {
  await pool.end();
}
