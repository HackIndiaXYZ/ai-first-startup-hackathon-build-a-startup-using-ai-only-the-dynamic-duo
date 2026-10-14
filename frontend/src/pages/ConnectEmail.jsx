import { useEffect, useState } from 'react';
import { useGmailAuth, PHASE } from '../hooks/useGmailAuth';
import {
  GMAIL_OAUTH_START_URL,
  parseCallbackParams,
  CALLBACK_ERROR_MESSAGES,
} from '../services/authApi';
import './ConnectEmail.css';

/**
 * ConnectEmail — TrialGuard Phase 3A C4.
 *
 * Renders the Gmail connection interface on /connect-email (also the landing
 * target of the backend's OAuth callback redirect). The four required UI
 * states map to hook phases:
 *
 *   "Connect Gmail"   → launches a FULL browser redirect to /api/auth/google
 *                       (plain anchor navigation). The code exchange happens
 *                       only on the Express backend, never in React.
 *   "Checking…"       → status request in flight.
 *   "Connected as …"  → server says connected, shows the authorized email.
 *   Error             → status lookup failed or an OAuth error query param
 *                       was redirected back from the callback.
 *
 * SECURITY: this component never touches tokens or session ids — it only
 * knows the display email. Callback query params are consumed once and
 * removed from the URL, and nothing is written to any web storage.
 */

/** Banner (heading/body/kind) derived from the OAuth callback redirect query. */
function bannerFromCallback(params) {
  if (params.errorCode) {
    return {
      kind: 'error',
      title: 'Connection not completed',
      body: CALLBACK_ERROR_MESSAGES[params.errorCode],
    };
  }
  if (params.successEmail) {
    return {
      kind: 'success',
      title: 'Gmail connected',
      body: `Google authorization complete. TrialGuard is now allowed to read emails sent to ${params.successEmail} — automatic detection will begin with the scanning phase.`,
    };
  }
  return null;
}

export default function ConnectEmail() {
  const { phase, email, statusError, disconnecting, refresh, disconnect } = useGmailAuth();
  // Banner is derived once at mount from the OAuth callback redirect query —
  // a lazy initializer, no setState-in-effect cascade.
  const [banner, setBanner] = useState(() =>
    bannerFromCallback(parseCallbackParams(window.location.search))
  );
  const [disconnectNotice, setDisconnectNotice] = useState(() => null);

  // Consume the callback query exactly once by scrubbing it from the URL
  // (address-bar hygiene only; the banner already holds the parsed result).
  useEffect(() => {
    if (banner) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [banner]);

  async function handleDisconnect() {
    setDisconnectNotice(null);
    const ok = await disconnect();
    // Success state is rendered by the hook phase flip; failure shows a notice.
    if (!ok) {
      setBanner({
        kind: 'error',
        title: 'Disconnect failed',
        body: 'Your connection is still active. Please try again in a moment.',
      });
    }
  }

  const isChecking = phase === PHASE.checking;
  const isConnected = phase === PHASE.connected;
  const isNotConnected = phase === PHASE.not_connected;
  const isError = phase === PHASE.error;

  return (
    <main className="connect-page" aria-live="polite">
      <header className="connect-page__header">
        <div>
          <h1 className="connect-page__title">Connect Email</h1>
          <p className="connect-page__subtitle">
            Allow TrialGuard to scan your Gmail <strong>read-only</strong> for free-trial
            and subscription emails. TrialGuard can never send, delete, or modify your mail.
          </p>
        </div>
      </header>

      {/* OAuth callback result banner */}
      {banner && (
        <div
          className={`connect-banner connect-banner--${banner.kind}`}
          role="status"
          data-testid="oauth-banner"
        >
          <strong>{banner.title}</strong>
          <p>{banner.body}</p>
        </div>
      )}

      {/* Connection status card */}
      <section className="connect-card" data-testid="status-card">
        <div className="connect-card__row">
          <span
            className={`connect-card__dot connect-card__dot--${
              isChecking ? 'checking' : isConnected ? 'connected' : isNotConnected ? 'idle' : 'error'
            }`}
            aria-hidden="true"
          />
          <div className="connect-card__main">
            {isChecking && (
              <>
                <h2 className="connect-card__heading">Checking connection…</h2>
                <p className="connect-card__meta">Talking to TrialGuard services.</p>
              </>
            )}
            {isConnected && (
              <>
                <h2 className="connect-card__heading">
                  Connected as <span className="connect-card__email">{email}</span>
                </h2>
                <p className="connect-card__meta">
                  Read-only Gmail access is granted and ready. Trial detection is not yet running —
                  this connection sets the stage for future scanning.
                </p>
              </>
            )}
            {isNotConnected && (
              <>
                <h2 className="connect-card__heading">Not connected</h2>
                <p className="connect-card__meta">
                  Connect your Gmail to prepare your account for trial scanning once the
                  detection phase is released.
                </p>
              </>
            )}
            {isError && (
              <>
                <h2 className="connect-card__heading">Connection status unavailable</h2>
                <p className="connect-card__meta">{statusError}</p>
              </>
            )}
          </div>
        </div>

        <div className="connect-card__actions">
          {(isNotConnected || isError) && !isChecking && (
            <>
              <a
                className="connect-btn"
                href={GMAIL_OAUTH_START_URL}
                data-testid="connect-link"
              >
                Connect Gmail
              </a>
              <button
                type="button"
                className="connect-btn--ghost"
                onClick={refresh}
                data-testid="retry-status"
              >
                Check status again
              </button>
            </>
          )}
          {isConnected && (
            <button
              type="button"
              className="connect-btn connect-btn--danger"
              onClick={handleDisconnect}
              disabled={disconnecting}
              data-testid="disconnect-btn"
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect Gmail'}
            </button>
          )}
        </div>
      </section>

      {disconnectNotice && (
        <div className="connect-banner connect-banner--error" role="status">
          <strong>{disconnectNotice.title}</strong>
          <p>{disconnectNotice.body}</p>
        </div>
      )}

      <section className="connect-privacy">
        <h3 className="connect-privacy__title">What you're agreeing to</h3>
        <ul className="connect-privacy__list">
          <li>
            <strong>What connection grants:</strong> once scanning ships, the reader will monitor emails sent to your address so trials can be detected up to 30 days ahead. Monitoring is not yet active.
          </li>
          <li>
            <strong>Scope:</strong> strictly <code>gmail.readonly</code>. TrialGuard actions are limited to reading message metadata and snippets.
          </li>
          <li>
            <strong>Storage:</strong> connection uses a signed HttpOnly session cookie and encrypted OAuth tokens on our servers. Nothing about your Google session is stored in this browser.
          </li>
        </ul>
      </section>
    </main>
  );
}
