import './Sidebar.css';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '⊞', active: true },
  { id: 'subscriptions', label: 'My Subscriptions', icon: '☰', active: false },
  { id: 'reminders', label: 'Reminders', icon: '🔔', active: false },
  { id: 'settings', label: 'Settings', icon: '⚙', active: false },
];

export default function Sidebar({ currentPage, onNavigate }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">🛡</span>
        <span className="sidebar-name">TrialGuard</span>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          const isCurrent = item.id === currentPage;
          const isDisabled = !item.active && item.id !== 'dashboard';
          return (
            <button
              key={item.id}
              className={`sidebar-item ${isCurrent ? 'sidebar-item--active' : ''} ${isDisabled ? 'sidebar-item--disabled' : ''}`}
              onClick={() => !isDisabled && onNavigate(item.id)}
              title={isDisabled ? 'Coming soon' : item.label}
              aria-current={isCurrent ? 'page' : undefined}
              disabled={isDisabled}
            >
              <span className="sidebar-icon">{item.icon}</span>
              <span className="sidebar-label">{item.label}</span>
              {isDisabled && <span className="sidebar-badge">Soon</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <p>Phase 1 — MVP</p>
      </div>
    </aside>
  );
}
