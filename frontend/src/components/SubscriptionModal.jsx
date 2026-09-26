import StatusBadge from './StatusBadge';
import { daysRemaining, resolvedStatus } from '../utils/subscriptionStatus';
import './SubscriptionModal.css';

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function SubscriptionModal({ subscription, onClose }) {
  if (!subscription) return null;
  const days = daysRemaining(subscription.trialEndDate);
  const status = resolvedStatus(subscription);

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick} role="dialog" aria-modal="true" aria-label={`Details for ${subscription.serviceName}`}>
      <div className="modal">
        <div className="modal__header">
          <div className="modal__service-initial">
            {subscription.serviceName.charAt(0)}
          </div>
          <div className="modal__title-group">
            <h2 className="modal__service">{subscription.serviceName}</h2>
            <span className="modal__plan">{subscription.planName}</span>
          </div>
          <button className="modal__close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="modal__status-row">
          <StatusBadge status={status} />
          {days >= 0 && status !== 'cancelled' && (
            <span className={`modal__days ${days <= 7 ? 'modal__days--warn' : ''}`}>
              {days === 0 ? 'Ends today' : `${days} days remaining`}
            </span>
          )}
        </div>

        <dl className="modal__details">
          <div className="modal__detail-row">
            <dt>Trial started</dt>
            <dd>{formatDate(subscription.trialStartDate)}</dd>
          </div>
          <div className="modal__detail-row">
            <dt>Trial ends</dt>
            <dd>{formatDate(subscription.trialEndDate)}</dd>
          </div>
          <div className="modal__detail-row">
            <dt>Price after trial</dt>
            <dd>{subscription.currency} {subscription.price.toFixed(2)} / month</dd>
          </div>
          <div className="modal__detail-row">
            <dt>Status</dt>
            <dd>{subscription.status}</dd>
          </div>
        </dl>

        <div className="modal__notice">
          <span className="modal__notice-icon">ℹ</span>
          Cancellation assistance will be available in a future update. To cancel now, visit the service directly.
        </div>

        <div className="modal__footer">
          <a
            href={subscription.cancellationUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="modal__link-btn"
          >
            Open cancellation page ↗
          </a>
          <button className="modal__close-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
