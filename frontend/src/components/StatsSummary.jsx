import { resolvedStatus } from '../utils/subscriptionStatus';
import './StatsSummary.css';

function computeStats(subscriptions) {
  const total = subscriptions.length;

  // Active = trial is still running (includes expiring_soon).
  const activeTrials = subscriptions.filter((s) => {
    const rs = resolvedStatus(s);
    return rs === 'active' || rs === 'expiring_soon';
  }).length;

  const expiringSoon = subscriptions.filter(
    (s) => resolvedStatus(s) === 'expiring_soon'
  ).length;

  // Potential post-trial charges: active trials that have not yet ended.
  // Excludes expired and cancelled subscriptions.
  //price part: skip subscriptions with null/non-finite price so they do not add as $0
  const potentialCharges = subscriptions
    .filter((s) => {
      const rs = resolvedStatus(s);
      return rs === 'active' || rs === 'expiring_soon';
    })
    .reduce((sum, s) => sum + (s.price != null && isFinite(s.price) ? s.price : 0), 0);

  return { total, activeTrials, expiringSoon, potentialCharges };
}

export default function StatsSummary({ subscriptions }) {
  const { total, activeTrials, expiringSoon, potentialCharges } = computeStats(subscriptions);

  return (
    <div className="stats-grid">
      <div className="stat-card">
        <span className="stat-card__value">{total}</span>
        <span className="stat-card__label">Total subscriptions</span>
      </div>
      <div className="stat-card">
        <span className="stat-card__value stat-card__value--blue">{activeTrials}</span>
        <span className="stat-card__label">Active free trials</span>
      </div>
      <div className={`stat-card ${expiringSoon > 0 ? 'stat-card--warn' : ''}`}>
        <span className={`stat-card__value ${expiringSoon > 0 ? 'stat-card__value--warn' : ''}`}>
          {expiringSoon}
        </span>
        <span className="stat-card__label">Expiring within 7 days</span>
      </div>
      <div className="stat-card">
        <span className="stat-card__value stat-card__value--purple">
          ${potentialCharges.toFixed(2)}
        </span>
        <span className="stat-card__label">Potential charges if not cancelled</span>
      </div>
    </div>
  );
}
