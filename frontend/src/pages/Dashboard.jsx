import { useState } from 'react';
import { useSubscriptions } from '../hooks/useSubscriptions';
import SubscriptionCard from '../components/SubscriptionCard';
import SubscriptionModal from '../components/SubscriptionModal';
import StatsSummary from '../components/StatsSummary';
import './Dashboard.css';

export default function Dashboard() {
  const { subscriptions, loading, error, retry } = useSubscriptions();
  const [selectedSub, setSelectedSub] = useState(null);

  if (loading) {
    return (
      <div className="dashboard-state">
        <div className="spinner" role="status" aria-label="Loading subscriptions" />
        <p>Loading your subscriptions…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-state dashboard-state--error">
        <span className="dashboard-state__icon">⚠</span>
        <h2>Could not load subscriptions</h2>
        <p>{error}</p>
        <p className="dashboard-state__hint">Make sure the backend is running on port 3001.</p>
        <button className="dashboard-state__retry" onClick={retry}>Retry</button>
      </div>
    );
  }

  if (subscriptions.length === 0) {
    return (
      <div className="dashboard-state">
        <span className="dashboard-state__icon">📭</span>
        <h2>No subscriptions found</h2>
        <p>Once your email is connected, TrialGuard will detect your active trials here.</p>
      </div>
    );
  }

  // CP5: user-saved subscriptions are separated from the six demo rows.
  // Ledger: every user-saved row carries source === 'scan' (migration 004);
  // anything else (incl. backend versions without the column) is demo data.
  const savedSubscriptions = subscriptions.filter((sub) => sub.source === 'scan');
  const demoSubscriptions = subscriptions.filter((sub) => sub.source !== 'scan');

  return (
    <main className="dashboard">
      <div className="dashboard__header">
        <div>
          <h1 className="dashboard__title">Dashboard</h1>
          <p className="dashboard__subtitle">
            Overview of your active free trials and subscriptions.
          </p>
        </div>
      </div>

      <StatsSummary subscriptions={subscriptions} />

      {savedSubscriptions.length > 0 && (
        <section>
          <h2 className="dashboard__section-title">Saved from Gmail</h2>
          <p className="dashboard__subtitle">
            Subscriptions you saved from scan results on the Connect Email page.
          </p>
          <div className="sub-grid">
            {savedSubscriptions.map((sub) => (
              <SubscriptionCard
                key={sub.id}
                subscription={sub}
                onViewDetails={setSelectedSub}
              />
            ))}
          </div>
        </section>
      )}

      {demoSubscriptions.length > 0 && (
        <section>
          <h2 className="dashboard__section-title">Demo data</h2>
          <p className="dashboard__subtitle">
            Fictional sample subscriptions included with TrialGuard — not from your mailbox.
          </p>
          <div className="sub-grid">
            {demoSubscriptions.map((sub) => (
              <SubscriptionCard
                key={sub.id}
                subscription={sub}
                onViewDetails={setSelectedSub}
              />
            ))}
          </div>
        </section>
      )}

      {selectedSub && (
        <SubscriptionModal
          subscription={selectedSub}
          onClose={() => setSelectedSub(null)}
        />
      )}
    </main>
  );
}
