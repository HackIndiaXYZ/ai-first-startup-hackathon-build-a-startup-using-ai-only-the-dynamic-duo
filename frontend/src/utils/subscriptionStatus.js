/**
 * Shared subscription status utilities.
 *
 * Single source of truth for status resolution and days-remaining calculation.
 * Used by SubscriptionCard, SubscriptionModal, and StatsSummary.
 *
 * Status hierarchy (checked in order):
 *   'cancelled'     — explicitly cancelled by the user (stored status field)
 *   'expired'       — trial end date is in the past, not explicitly cancelled
 *   'expiring_soon' — trial ends within 7 days (inclusive of today)
 *   'active'        — trial is running with more than 7 days remaining
 */

/**
 * Returns the integer number of days between today (midnight local) and dateStr.
 * Negative values mean the date is in the past.
 * @param {string} dateStr  YYYY-MM-DD
 * @returns {number}
 */
export function daysRemaining(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(dateStr);
  return Math.ceil((end - today) / (1000 * 60 * 60 * 24));
}

/**
 * Derives a display status from a subscription object.
 * The stored `status` field is the authoritative cancelled marker;
 * expiry state is always computed from the date so it stays current.
 *
 * @param {{ status: string, trialEndDate: string }} subscription
 * @returns {'active' | 'expiring_soon' | 'expired' | 'cancelled'}
 */
export function resolvedStatus(subscription) {
  if (subscription.status === 'cancelled') return 'cancelled';
  const days = daysRemaining(subscription.trialEndDate);
  if (days < 0) return 'expired';
  if (days <= 7) return 'expiring_soon';
  return 'active';
}
