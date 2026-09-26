import { useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
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

export default function App() {
  const [currentPage, setCurrentPage] = useState('dashboard');

  function renderPage() {
    switch (currentPage) {
      case 'dashboard':
        return <Dashboard />;
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
