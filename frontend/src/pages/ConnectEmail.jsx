import { useEffect, useState } from 'react';
import { useGmailAuth, PHASE } from '../hooks/useGmailAuth';
import { useScanNow, SCAN_STATUS, SAVE_STATUS } from '../hooks/useScanNow';
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

/* --- Scan Now display helpers (CP4) ---------------------------------------
   All rendering is whitelisted: unknown fields render as "Unknown", and
   nothing beyond the DTO fields (no message ids, no snippets, no addresses)
   is ever shown. */

const CLASSIFICATION_LABELS = {
  trial: 'Free trial',
  renewal: 'Renewal',
  cancellation: 'Cancellation',
  receipt: 'Receipt',
  payment_reminder: 'Payment reminder',
};

/** Controlled issue-type vocabulary (approved decision) → human labels. */
const PAYMENT_ISSUE_LABELS = {
  payment_failed: 'Payment failed',
  payment_action_required: 'Action required',
  access_expiring: 'Access expiring',
};

function paymentIssueLabel(c) {
  return c.paymentIssueType == null ? null : (PAYMENT_ISSUE_LABELS[c.paymentIssueType] ?? null);
}

/** Per-item save failure reasons (backend `failed[].reason`) → human text. */
const SAVE_FAILURE_LABELS = {
  not_in_scan: 'not part of this scan selection',
  invalid_fields: 'details could not be validated',
  db_error: 'a temporary TrialGuard problem — try again',
};

function saveFailureLabel(reason) {
  return SAVE_FAILURE_LABELS[reason] ?? 'an unknown problem';
}

/** The date fields RELEVANT to each classification, null-aware. For a
    payment reminder the deadline label reflects the issue type: the same
    null-for-unknown rule applies — a missing deadline renders "Unknown". */
function relevantDates(c) {
  switch (c.classification) {
    case 'trial':
      return [['Trial ends', c.trialEndDate]];
    case 'renewal':
      return [['Renews on', c.renewalDate]];
    case 'cancellation':
      return [['Cancel before', c.cancellationDeadline]];
    case 'receipt':
      return [
        ['Invoice date', c.invoiceDate],
        ['Next billing', c.renewalDate],
      ];
    case 'payment_reminder':
      return [[
        c.paymentIssueType === 'access_expiring' ? 'Access ends' : 'Payment deadline',
        c.paymentDeadline,
      ]];
    default:
      return [];
  }
}

function dateLabel(value) {
  return value == null ? 'Unknown' : value; // backend dates are yyyy-mm-dd strings
}

function confidenceLabel(c) {
  return c.confidence
    ? `${c.confidence.charAt(0).toUpperCase()}${c.confidence.slice(1)} confidence`
    : 'Unknown';
}

export default function ConnectEmail() {
  const { phase, email, statusError, disconnecting, refresh, disconnect } = useGmailAuth();
  const scan = useScanNow();
  // Banner is derived once at mount from the OAuth callback redirect query —
  // a lazy initializer, no setState-in-effect cascade.
  const [banner, setBanner] = useState(() =>
    bannerFromCallback(parseCallbackParams(window.location.search))
  );
  const [disconnectNotice, setDisconnectNotice] = useState(() => null);
  // Two-step confirmation (approved correction 7): the first click only arms
  // the button — nothing saves until the explicit confirm click.
  const [saveArmed, setSaveArmed] = useState(false);

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
    if (ok) {
      // Scan results belonged to the now-disconnected account — drop them.
      scan.reset();
    } else {
      setBanner({
        kind: 'error',
        title: 'Disconnect failed',
        body: 'Your connection is still active. Please try again in a moment.',
      });
    }
  }

  const isScanning = scan.status === SCAN_STATUS.scanning;
  const hasResults = scan.status === SCAN_STATUS.done && scan.results;
  const reconnectCodes = new Set(['reconnect_required', 'token_expired', 'permission_denied', 'not_connected']);
  const selectedCount = scan.selectedIds.size;
  const candidates = hasResults ? scan.results.candidates : [];
  const isSaving = scan.saveStatus === SAVE_STATUS.saving;
  const scanHasRef = Boolean(scan.results?.scanRef);

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
                  Read-only Gmail access is granted. Scanning is manual only — use Scan Now below;
                  there is no background monitoring and nothing is saved automatically.
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

      {/* Manual Scan Now (CP4) — rendered ONLY while Gmail is connected. */}
      {isConnected && (
        <section className="scan-section" data-testid="scan-section" aria-live="polite">
          <h2 className="scan-section__title">Detect trials and subscriptions</h2>
          <p className="scan-section__meta">
            Scan Now reads the last 90 days of your mail, read-only, for trial, renewal,
            receipt, and cancellation emails. The scan runs only when you click —
            there is no background monitoring and no automatic saving.
          </p>

          <div className="scan-section__actions">
            <button
              type="button"
              className="scan-btn"
              onClick={() => scan.scan()}
              disabled={isScanning}
              data-testid="scan-now"
            >
              {isScanning && <span className="scan-btn__spinner" aria-hidden="true" />}
              {isScanning ? 'Scanning…' : 'Scan Now'}
            </button>
          </div>

          {scan.error && (
            <div
              className="connect-banner connect-banner--error"
              role="alert"
              data-testid="scan-error"
            >
              <strong>
                {reconnectCodes.has(scan.error.code) ? 'Reconnect required' : 'Scan failed'}
              </strong>
              <p>{scan.error.message}</p>
              {reconnectCodes.has(scan.error.code) && (
                <p className="connect-banner__hint">
                  Use Disconnect Gmail above first — a fresh connection starts a new authorization.
                </p>
              )}
            </div>
          )}

          {hasResults && candidates.length === 0 && (
            <div className="scan-empty" data-testid="scan-empty">
              <strong>No subscriptions detected</strong>
              <p>
                No trial, renewal, receipt, or cancellation emails were found in the
                last {scan.results.windowDays ?? 90} days of your mailbox.
              </p>
            </div>
          )}

          {hasResults && candidates.length > 0 && (
            <div data-testid="scan-results">
              <p className="scan-results__meta">
                Last {scan.results.windowDays ?? 90} days:{' '}
                {scan.results.messagesListed ?? 'Unknown'} emails matched,{' '}
                {scan.results.messagesDeduped ?? 'Unknown'} unique,{' '}
                {scan.results.messagesSelected ?? 'Unknown'} selected for inspection,{' '}
                {candidates.length} detected.
                {scan.results.partial &&
                  ' Some eligible messages were excluded by TrialGuard\'s retrieval caps or Gmail limited the request — results may be incomplete.'}
              </p>

              <ul className="scan-results__list">
                {candidates.map((c) => (
                  <li className="scan-candidate" key={c.sourceMessageId ?? confidenceLabel(c)} data-testid="scan-candidate">
                    <label className="scan-candidate__select">
                      <input
                        type="checkbox"
                        checked={scan.selectedIds.has(c.sourceMessageId)}
                        onChange={() => {
                          setSaveArmed(false); // selection changed → disarm confirm
                          scan.toggleCandidate(c.sourceMessageId);
                        }}
                        data-testid={`scan-select-${c.sourceMessageId ?? 'unknown'}`}
                      />
                      <span>Save later</span>
                    </label>
                    <div className="scan-candidate__main">
                      <div className="scan-candidate__head">
                        <strong
                          className="scan-candidate__name"
                          data-testid={`scan-name-${c.sourceMessageId ?? 'unknown'}`}
                        >
                          {c.serviceName ?? 'Unknown'}
                        </strong>
                        <span className={`scan-badge scan-badge--${c.classification}`}>
                          {CLASSIFICATION_LABELS[c.classification] ?? 'Unknown'}
                        </span>
                        <span className={`scan-confidence scan-confidence--${c.confidence ?? 'unknown'}`}>
                          {confidenceLabel(c)}
                        </span>
                      </div>
                      <dl className="scan-candidate__details">
                        {paymentIssueLabel(c) != null && (
                          <div
                            className="scan-candidate__detail"
                            data-testid="scan-detail-notice"
                          >
                            <dt>Notice</dt>
                            <dd>{paymentIssueLabel(c)}</dd>
                          </div>
                        )}
                        {relevantDates(c).map(([label, value]) => (
                          <div
                            key={label}
                            className="scan-candidate__detail"
                            data-testid={`scan-detail-${label.toLowerCase().replace(/\s+/g, '-')}`}
                          >
                            <dt>{label}</dt>
                            <dd>{dateLabel(value)}</dd>
                          </div>
                        ))}
                        <div className="scan-candidate__detail" data-testid="scan-detail-price">
                          <dt>Price</dt>
                          <dd>{c.price == null ? 'Unknown' : c.price}</dd>
                        </div>
                        <div className="scan-candidate__detail" data-testid="scan-detail-currency">
                          <dt>Currency</dt>
                          <dd>{c.currency ?? 'Unknown'}</dd>
                        </div>
                      </dl>
                    </div>
                  </li>
                ))}
              </ul>

              <p className="scan-selection-note" data-testid="scan-selection-note">
                {selectedCount === 0
                  ? 'Tick candidates to remember your picks.'
                  : `${selectedCount} selected.`}
              </p>

              {/* CP5-C: Save Selected — explicit two-step confirmation. Visible
                  ONLY when ≥1 candidate is ticked; first click arms, second click
                  saves. Nothing saves automatically, ever. */}
              {selectedCount > 0 && (
                <div className="scan-save-block" data-testid="scan-save-section">
                  {!scanHasRef && (
                    <p className="scan-save__hint" data-testid="scan-ref-missing">
                      This scan has no saving reference, so it cannot be saved yet.
                      This can happen if the server restarted or could not create one.
                      Run Scan Now again, then select and save again.
                    </p>
                  )}
                  {scanHasRef && !saveArmed && !isSaving && (
                    <button
                      type="button"
                      className="scan-btn"
                      onClick={() => setSaveArmed(true)}
                      data-testid="scan-save"
                    >
                      Save {selectedCount} selected
                    </button>
                  )}
                  {saveArmed && !isSaving && (
                    <div className="scan-save__confirm" data-testid="scan-save-confirm-row">
                      <button
                        type="button"
                        className="scan-btn"
                        onClick={async () => {
                          setSaveArmed(false);
                          await scan.save();
                        }}
                        data-testid="scan-save"
                      >
                        Confirm saving {selectedCount}
                      </button>
                      <button
                        type="button"
                        className="connect-btn--ghost"
                        onClick={() => setSaveArmed(false)}
                        data-testid="scan-save-cancel"
                      >
                        Cancel
                      </button>
                      <p className="scan-save__hint">
                        Saving adds these {selectedCount} subscriptions to your Dashboard.
                      </p>
                    </div>
                  )}
                  {isSaving && (
                    <button type="button" className="scan-btn" disabled data-testid="scan-save">
                      <span className="scan-btn__spinner" aria-hidden="true" />
                      Saving…
                    </button>
                  )}
                </div>
              )}

              {/* Per-item outcomes (approved correction 7): saved, already saved,
                  and failed are each shown individually; failed selections REMAIN
                  ticked for retry. */}
              {scan.saveOutcomes && (
                <div className="scan-outcomes" data-testid="scan-save-outcomes">
                  <strong>Save results</strong>
                  {scan.saveOutcomes.saved.length > 0 && (
                    <p data-testid="scan-save-saved">
                      Saved {scan.saveOutcomes.saved.length} subscription
                      {scan.saveOutcomes.saved.length === 1 ? '' : 's'}:{' '}
                      {scan.saveOutcomes.saved.map((r) => r.serviceName).join(', ')}
                    </p>
                  )}
                  {scan.saveOutcomes.alreadySaved.length > 0 && (
                    <p data-testid="scan-save-already">
                      Already saved: {scan.saveOutcomes.alreadySaved.length}
                    </p>
                  )}
                  {scan.saveOutcomes.failed.length > 0 && (
                    <p data-testid="scan-save-failed">
                      Failed {scan.saveOutcomes.failed.length} (still selected for retry){' '}
                      — {scan.saveOutcomes.failed.map((f) => saveFailureLabel(f.reason)).join('; ')}
                    </p>
                  )}
                </div>
              )}

              {scan.saveError && (
                <div
                  className="connect-banner connect-banner--error"
                  role="alert"
                  data-testid="scan-save-error"
                >
                  <strong>
                    {scan.saveError.code === 'scan_expired' ? 'Scan reference expired' : 'Saving failed'}
                  </strong>
                  <p>{scan.saveError.message}</p>
                  {scan.saveError.code === 'scan_expired' && (
                    <p data-testid="save-error-hint">
                      A saving window lasts about 10 minutes and is cleared if the server restarts.
                      Run Scan Now again to start a new one.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section className="connect-privacy">
        <h3 className="connect-privacy__title">What you're agreeing to</h3>
        <ul className="connect-privacy__list">
          <li>
            <strong>What connection grants:</strong> read-only access so the manual Scan Now button can read emails sent to your address and detect trials and renewals. Scanning runs only when you click it — there is no automatic background monitoring.
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
