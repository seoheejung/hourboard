const HOUR_MS = 60 * 60 * 1000;
const SLOT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/;

export function currentSlot(now: Date) {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
}

export function nextSlot(slot: Date) {
  return new Date(slot.getTime() + HOUR_MS);
}

export function parseSlot(value: unknown): Date | null {
  if (typeof value !== 'string' || !SLOT_PATTERN.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : date;
}
