/**
 * Application errors carry an HTTP status and a stable machine-readable code
 * that frontends switch on (e.g. LIMIT_REACHED -> show upgrade prompt).
 */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const BadRequest = (msg = 'Bad request', details) => new AppError(400, 'BAD_REQUEST', msg, details);
export const ValidationError = (details) => new AppError(422, 'VALIDATION_ERROR', 'Validation failed', details);
export const Unauthorized = (msg = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, msg);
export const Forbidden = (msg = 'You do not have permission to perform this action', code = 'FORBIDDEN', details) =>
  new AppError(403, code, msg, details);
export const NotFound = (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const Conflict = (msg, code = 'CONFLICT', details) => new AppError(409, code, msg, details);
export const TooManyRequests = (msg = 'Too many requests') => new AppError(429, 'RATE_LIMITED', msg);

// Subscription-specific
export const PaymentRequired = (msg, details) => new AppError(402, 'SUBSCRIPTION_INACTIVE', msg, details);
export const FeatureNotInPlan = (feature) =>
  new AppError(403, 'FEATURE_NOT_IN_PLAN', `Your plan does not include "${feature}". Upgrade to enable it.`, {
    feature,
    upgrade: true,
  });
export const LimitReached = (metric, limit, current) =>
  new AppError(
    403,
    'LIMIT_REACHED',
    `Your plan allows ${limit} ${metric}. Upgrade your subscription to add more.`,
    { metric, limit, current, upgrade: true },
  );
