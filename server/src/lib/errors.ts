export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'conflict'
  | 'insufficient_stock'
  | 'schedule_conflict'
  | 'rate_limited'
  | 'upstream_error'
  /** A spending limit ran out (the AI budget of the month, the Polza balance or key limit). */
  | 'payment_required'
  | 'payment_provider_error'
  | 'internal';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_error: 400,
  conflict: 409,
  insufficient_stock: 409,
  schedule_conflict: 409,
  rate_limited: 429,
  upstream_error: 502,
  payment_required: 402,
  payment_provider_error: 502,
  internal: 500,
};

/** An error whose message is safe to show to the user as is (Russian). */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
  }

  toBody(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export const notFound = (message = 'Не найдено'): AppError => new AppError('not_found', message);
export const badRequest = (message: string): AppError => new AppError('validation_error', message);
export const conflict = (message: string): AppError => new AppError('conflict', message);
export const unauthorized = (message = 'Требуется вход в систему'): AppError =>
  new AppError('unauthorized', message);
export const insufficientStock = (message: string): AppError => new AppError('insufficient_stock', message);
export const scheduleConflict = (message: string): AppError => new AppError('schedule_conflict', message);
/** An external service (e.g. AI image generation) failed; the message says why. */
export const upstreamError = (message: string): AppError => new AppError('upstream_error', message);

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
