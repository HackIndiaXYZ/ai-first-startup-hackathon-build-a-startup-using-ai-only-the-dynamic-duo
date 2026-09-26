import StatusBadge from './StatusBadge';
import { daysRemaining, resolvedStatus } from '../utils/subscriptionStatus';
import './SubscriptionCard.css';

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function SubscriptionCard({ subscription, onViewDetails }) {
  const days = daysRemaining(subscription.trialEndDate);
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
            {subscription.currency} {subscription.price.toFixed(2)}/mo
          </span>
        </div>
        <div className="sub-card__stat">
          <span className="sub-card__stat-label">Days remaining</span>
          <span className={`sub-card__stat-value sub-card__days ${days <= 7 && days >= 0 ? 'sub-card__days--warn' : ''} ${days < 0 ? 'sub-card__days--over' : ''}`}>
            {days < 0 ? 'Trial ended' : days === 0 ? 'Ends today' : `${days} days`}
          </span>
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
