export const ErrorCodes = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  CONFLICT: 409,
  SEAT_UNAVAILABLE: 409,
  HOLD_EXPIRED: 410,
  HOLD_NOT_FOUND: 404,
  INVALID_STATE_TRANSITION: 409,
  RATE_LIMITED: 429,
  PAYMENT_UNSUCCESSFUL: 402,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export function apiError(code: ErrorCode, message: string): Error & { statusCode: number; code: string } {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = ErrorCodes[code];
  err.code = code;
  return err;
}
