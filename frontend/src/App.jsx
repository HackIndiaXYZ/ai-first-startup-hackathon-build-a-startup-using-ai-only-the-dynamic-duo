import { useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import ConnectEmail from './pages/ConnectEmail';
import './App.css';

// Placeholder for pages not yet implemented
function ComingSoon({ page }) {
  return (
    <div className="coming-soon">
      <span className="coming-soon__icon">🚧</span>
      <h2>{page}</h2>
      <p>This section is coming in a future phase.</p>
    </div>
  );
}

// The Express OAuth callback (C3) 302s the browser back to
// FRONTEND_URL + '/connect-email' — that path opens the Connect Email page.
const CALLBACK_PAGE_PATH = '/connect-email';

function initialPage() {
  return window.location.pathname === CALLBACK_PAGE_PATH ? 'connect-email' : 'dashboard';
}

export default function App() {
  const [currentPage, setCurrentPage] = useState(initialPage);

  function renderPage() {
    switch (currentPage) {
      case 'dashboard':
        return <Dashboard />;
      case 'connect-email':
        return <ConnectEmail />;
      case 'subscriptions':
        return <ComingSoon page="My Subscriptions" />;
      case 'reminders':
        return <ComingSoon page="Reminders" />;
      case 'settings':
        return <ComingSoon page="Settings" />;
      default:
        return <Dashboard />;
    }
  }

  return (
    <div className="app-shell">
      <Sidebar currentPage={currentPage} onNavigate={setCurrentPage} />
      <div className="app-content">
        {renderPage()}
      </div>
    </div>
  );
}
