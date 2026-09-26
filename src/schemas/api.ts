export const attemptBodySchema = {
  type: 'object',
  required: ['slotAt', 'message'],
  additionalProperties: false,
  properties: {
    slotAt: { type: 'string' },
    message: { type: 'string', maxLength: 120 }
  }
} as const;
