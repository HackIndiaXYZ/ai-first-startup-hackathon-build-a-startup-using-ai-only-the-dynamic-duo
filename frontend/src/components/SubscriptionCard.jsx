import StatusBadge from './StatusBadge';
import { daysRemaining, resolvedStatus } from '../utils/subscriptionStatus';
import './SubscriptionCard.css';

//date part: guard null — new Date(null) gives epoch, not "Unknown"
function formatDate(dateStr) {
  if (!dateStr) return 'Unknown';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

//price part: guard null/non-finite so toFixed is never called on null
function formatPrice(price, currency) {
  if (price == null || !isFinite(price)) return 'Unknown';
  if (currency) return `${currency} ${price.toFixed(2)}/mo`;
  return `${price.toFixed(2)}/mo`;
}

export default function SubscriptionCard({ subscription, onViewDetails }) {
  //days part: guard null trialEndDate before computing days
  const days = subscription.trialEndDate != null ? daysRemaining(subscription.trialEndDate) : null;
  const status = resolvedStatus(subscription);

  return (
    <article className="sub-card">
      <div className="sub-card__header">
        <div className="sub-card__service-initial">
          {subscription.serviceName.charAt(0)}
        </div>
        <div className="sub-card__title-group">
          <h3 className="sub-card__service">{subscription.serviceName}</h3>
          <span className="sub-card__plan">{subscription.planName}</span>
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="sub-card__body">
        <div className="sub-card__stat">
          <span className="sub-card__stat-label">Trial ends</span>
          <span className="sub-card__stat-value">{formatDate(subscription.trialEndDate)}</span>
        </div>
        <div className="sub-card__stat">
          <span className="sub-card__stat-label">Price after trial</span>
          <span className="sub-card__stat-value">
            {formatPrice(subscription.price, subscription.currency)}
          </span>
        </div>
        <div className="sub-card__stat">
          <span className="sub-card__stat-label">Days remaining</span>
          {days == null ? (
            <span className="sub-card__stat-value">Unknown</span>
          ) : (
            <span className={`sub-card__stat-value sub-card__days ${days <= 7 && days >= 0 ? 'sub-card__days--warn' : ''} ${days < 0 ? 'sub-card__days--over' : ''}`}>
              {days < 0 ? 'Trial ended' : days === 0 ? 'Ends today' : `${days} days`}
            </span>
          )}
        </div>
      </div>

      <div className="sub-card__footer">
        <button
          className="sub-card__btn"
          onClick={() => onViewDetails(subscription)}
        >
          View Details
        </button>
      </div>
    </article>
  );
}
