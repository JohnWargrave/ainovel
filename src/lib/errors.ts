export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  // Diagnostics for the server log only — never serialized into the response body. Exists because
  // a deliberately vague client-facing message (e.g. "id_token verification failed") leaves nothing
  // to debug from, and putting the real reason in `message` would leak it to the caller.
  readonly details: Record<string, unknown> | undefined;
  // The opposite contract to `details`: everything here IS serialized into the response body, so it
  // must be safe for any caller to read. Exists for errors the client has to act on rather than just
  // display — REDEMPTION_HOLD_ACTIVE's claimable_at drives a countdown, and without it the app has
  // to spend a round trip on GET /redemptions to learn something the 409 already knew.
  // Never put internal ids, token claims, or config values in here.
  readonly publicDetails: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>,
    publicDetails?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.publicDetails = publicDetails;
  }
}
