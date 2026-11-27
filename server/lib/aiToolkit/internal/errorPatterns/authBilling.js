/** Classify authentication failures and billing exhaustion in process output and HTTP status. */
import { ERROR_CATEGORIES } from './categories.js';

export const billingRule = {
  pattern: /billing|payment|credit|insufficient funds/i,
  category: ERROR_CATEGORIES.QUOTA_EXCEEDED,
  requiresFallback: true,
  actionable: true,
  suggestedFix: 'Check billing status and add credits to the provider account'
};

export const authRule = {
  pattern: /unauthorized|invalid.?api.?key|authentication|forbidden|401|403/i,
  category: ERROR_CATEGORIES.AUTH_ERROR,
  requiresFallback: true,
  actionable: true,
  suggestedFix: 'Check API key configuration for this provider'
};

export function isAuthErrorStatus(statusCode) {
  return statusCode === 401 || statusCode === 403;
}
