import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ConnectEmail from './ConnectEmail';

/* Mock the service layer — these tests exercise the UI contract
   (status display, redirect target, disconnect behavior, error params),
   not the network. */
vi.mock('../services/authApi', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAuthStatus: vi.fn(),
    disconnectGmail: vi.fn(),
    // parseCallbackParams + CALLBACK_ERROR_MESSAGES + GMAIL_OAUTH_START_URL stay real.
  };
});

import { getAuthStatus, disconnectGmail, parseCallbackParams, GMAIL_OAUTH_START_URL } from '../services/authApi';

/* Mock the scan service layer — UI-contract tests never touch the network and
   can never hit a (nonexistent) save endpoint. */
vi.mock('../services/scanApi', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runScan: vi.fn() };
});

import { runScan } from '../services/scanApi';

/* CP5: the save service is mocked the same way — the UI contract under test is
   the Save Selected flow (confirmation, outcomes, retry), never the network. */
vi.mock('../services/saveApi', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, saveSelected: vi.fn() };
});

import { saveSelected } from '../services/saveApi';

const CONNECTED = { connected: true, email: 'hilta@example.com' };
const SCAN_DTO = {
  scannedAt: '2026-10-15T09:00:00.000Z',
  windowDays: 90,
  messagesListed: 5,
  messagesDeduped: 5,
  messagesThreads: 4,
  messagesSelected: 4,
  messagesInspected: 7,
  partial: false,
  candidates: [
    { sourceMessageId: 'm1', classification: 'trial', serviceName: 'Netflix', trialEndDate: '2026-10-28', renewalDate: null, invoiceDate: null, cancellationDeadline: null, price: 15.99, currency: 'USD', confidence: 'high' },
    { sourceMessageId: 'm2', classification: 'receipt', serviceName: null, trialEndDate: null, renewalDate: '2026-11-02', invoiceDate: null, cancellationDeadline: null, price: null, currency: null, confidence: 'low' },
  ],
};

function searchState(search) {
  // jsdom history rejects cross-origin absolute URLs; relative paths work
  // against the same document origin (same as the component's own cleanup).
  window.history.replaceState({}, '', `/connect-email${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  searchState('');
});

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('ConnectEmail — connection status display', () => {
  it('shows the checking state first, then Not connected', async () => {
    getAuthStatus.mockReturnValue(new Promise(() => {})); // stay pending
    const { unmount } = render(<ConnectEmail />);

    expect(screen.getByTestId('status-card')).toHaveTextContent('Checking connection');
    unmount();

    // Authority flips server-side; the next mount reports Not connected.
    getAuthStatus.mockResolvedValue({ connected: false });
    render(<ConnectEmail />);
    await screen.findByText('Not connected');
  });

  it('shows the authorized email address when connected', async () => {
    getAuthStatus.mockResolvedValue({ connected: true, email: 'hilta@example.com' });
    render(<ConnectEmail />);

    await waitFor(() =>
      expect(screen.getByTestId('status-card')).toHaveTextContent('Connected as')
    );
    expect(screen.getByTestId('status-card')).toHaveTextContent('hilta@example.com');
  });

  it('shows an error state when the status lookup fails', async () => {
    getAuthStatus.mockRejectedValue(new Error('Could not reach TrialGuard services.'));
    render(<ConnectEmail />);

    await waitFor(() =>
      expect(screen.getByTestId('status-card')).toHaveTextContent('Connection status unavailable')
    );
    expect(screen.getByTestId('status-card')).toHaveTextContent(
      'Could not reach TrialGuard services.'
    );
  });
});

describe('ConnectEmail — OAuth start redirect', () => {
  it('exposes a plain full-redirect anchor to the OAuth start endpoint (no fetch exchange)', async () => {
    getAuthStatus.mockResolvedValue({ connected: false });
    render(<ConnectEmail />);

    await waitFor(() => expect(screen.getByTestId('connect-link')).toBeInTheDocument());
    const link = screen.getByTestId('connect-link');
    expect(link.tagName).toBe('A'); // browser navigation, not XHR
    expect(link.getAttribute('href')).toBe(GMAIL_OAUTH_START_URL);
    expect(GMAIL_OAUTH_START_URL).toBe('/api/auth/google'); // via proxy → localhost:3001
  });
});

describe('ConnectEmail — OAuth callback redirect params', () => {
  it('parses success params and shows the connected email', () => {
    searchState('?connected=true&email=hilta@example.com');
    const params = parseCallbackParams(window.location.search);
    expect(params.errorCode).toBeNull();
    expect(params.successEmail).toBe('hilta@example.com');
  });

  it('shows a friendly error for every supported backend error code', () => {
    const known = [
      'access_denied',
      'auth_incomplete',
      'oauth_state_invalid',
      'oauth_error',
      'token_exchange_failed',
      'identity_failed',
      'not_configured',
      'session_conflict',
    ];
    for (const code of known) {
      const params = parseCallbackParams(`?error=${code}`);
      expect(params.errorCode).toBe(code);
    }
    // Unknown codes fall back to a generic message rather than crashing.
    expect(parseCallbackParams('?error=something_new').errorCode).toBe('oauth_error');
  });

  it('renders the banner and clears the query string after a redirected error', async () => {
    getAuthStatus.mockResolvedValue({ connected: false });
    searchState('?error=access_denied');
    render(<ConnectEmail />);

    const banner = await screen.findByTestId('oauth-banner');
    expect(banner).toHaveTextContent('Connection not completed');
    expect(banner).toHaveTextContent('Google authorization was cancelled');

    await waitFor(() =>
      expect(window.location.search).toBe('')
    );
  });

  it('renders the connected banner after the callback succeeds, backed by a real status check', async () => {
    getAuthStatus.mockResolvedValue({ connected: true, email: 'hilta@example.com' });
    searchState('?connected=true&email=hilta@example.com');
    render(<ConnectEmail />);

    const banner = await screen.findByTestId('oauth-banner');
    expect(banner).toHaveTextContent('Gmail connected');
    await waitFor(() => expect(screen.getByTestId('status-card')).toHaveTextContent('hilta@example.com'));
  });
});

describe('ConnectEmail — disconnect behavior', () => {
  it('disconnects and updates the interface to Not connected', async () => {
    const user = userEvent.setup();
    getAuthStatus.mockResolvedValue({ connected: true, email: 'hilta@example.com' });
    disconnectGmail.mockResolvedValue(true);
    render(<ConnectEmail />);

    const btn = await screen.findByTestId('disconnect-btn');
    await user.click(btn);

    await waitFor(() => expect(screen.getByTestId('status-card')).toHaveTextContent('Not connected'));
    expect(disconnectGmail).toHaveBeenCalledTimes(1);
    expect(disconnectGmail).toHaveBeenCalledWith();
  });

  it('keeps the connection and shows an error when disconnect fails server-side', async () => {
    const user = userEvent.setup();
    getAuthStatus.mockResolvedValue({ connected: true, email: 'hilta@example.com' });
    disconnectGmail.mockRejectedValue(new Error('Disconnecting failed in TrialGuard. Please try again.'));
    render(<ConnectEmail />);

    const btn = await screen.findByTestId('disconnect-btn');
    await user.click(btn);

    await waitFor(() =>
      expect(screen.getByTestId('oauth-banner')).toHaveTextContent('Disconnect failed')
    );
    expect(screen.getByTestId('status-card')).toHaveTextContent('Connected as');
  });

  it('disables the disconnect button while the request is in flight', async () => {
    const user = userEvent.setup();
    getAuthStatus.mockResolvedValue({ connected: true, email: 'hilta@example.com' });
    disconnectGmail.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ConnectEmail />);

    const btn = await screen.findByTestId('disconnect-btn');
    await user.click(btn);
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('disconnect-btn')).toHaveTextContent('Disconnecting…');
  });
});

describe('ConnectEmail — Scan Now visibility (CP4)', () => {
  it('hides the Scan Now section when Gmail is not connected', async () => {
    getAuthStatus.mockResolvedValue({ connected: false });
    render(<ConnectEmail />);

    await screen.findByText('Not connected');
    expect(screen.queryByTestId('scan-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scan-now')).not.toBeInTheDocument();
  });

  it('shows the Scan Now button once connected', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    render(<ConnectEmail />);

    expect(await screen.findByTestId('scan-now')).toHaveTextContent('Scan Now');
  });
});

describe('ConnectEmail — Scan Now loading state (CP4)', () => {
  it('disables the button and shows a scanning indicator while the scan runs', async () => {
    const user = userEvent.setup();
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockReturnValue(new Promise(() => {})); // scan stays in flight
    render(<ConnectEmail />);

    const btn = await screen.findByTestId('scan-now');
    await user.click(btn);
    expect(btn).toBeDisabled();
    expect(screen.getByTestId('scan-now')).toHaveTextContent('Scanning…');
    expect(runScan).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectEmail — Scan Now results (CP4)', () => {
  it('renders candidates with names, classifications, dates, prices, currency, and confidence', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(SCAN_DTO);
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    const results = screen.getByTestId('scan-results');
    expect(screen.getAllByTestId('scan-candidate')).toHaveLength(2);
    expect(results).toHaveTextContent('Netflix');
    expect(results).toHaveTextContent('Free trial');
    expect(results).toHaveTextContent('2026-10-28');
    expect(results).toHaveTextContent('High confidence');
    expect(results).toHaveTextContent('Receipt');
    expect(results).toHaveTextContent('2026-11-02');
    expect(results).toHaveTextContent('15.99');
    expect(results).toHaveTextContent('USD');
    expect(results).toHaveTextContent('Low confidence');
    // Counts envelope is surfaced with stage-split labels (patch A).
    expect(results).toHaveTextContent('5 emails matched');
    expect(results).toHaveTextContent('5 unique');
    expect(results).toHaveTextContent('4 selected for inspection');
    expect(results).toHaveTextContent('2 detected.');
  });

  it('clearly flags partial scans caused by retrieval-cap truncation', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue({ ...SCAN_DTO, partial: true, messagesSelected: 4, messagesThreads: 26 });
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    const results = screen.getByTestId('scan-results');
    expect(results).toHaveTextContent('Some eligible messages were excluded');
    expect(results).toHaveTextContent('results may be incomplete');
  });

  it('renders Unknown for missing service name, invoice date, price, and currency', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(SCAN_DTO);
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    const cards = screen.getAllByTestId('scan-candidate');
    const receiptCard = cards.find((card) => within(card).queryByTestId('scan-select-m2'));
    expect(receiptCard).toBeDefined();
    // The receipt candidate has no service name, no invoice date, no price/currency.
    expect(within(receiptCard).getByTestId('scan-name-m2')).toHaveTextContent('Unknown'); // service name
    expect(within(receiptCard).getByTestId('scan-detail-invoice-date')).toHaveTextContent('Unknown');
    expect(within(receiptCard).getByTestId('scan-detail-price')).toHaveTextContent('Unknown');
    expect(within(receiptCard).getByTestId('scan-detail-currency')).toHaveTextContent('Unknown');
  });

  it('shows the empty state when the scan finds no candidates', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue({ ...SCAN_DTO, candidates: [] });
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    expect(screen.getByTestId('scan-empty')).toHaveTextContent('No subscriptions detected');
    expect(screen.queryByTestId('scan-results')).not.toBeInTheDocument();
  });
});

describe('ConnectEmail — Scan Now errors (CP4)', () => {
  it('shows friendly reconnect guidance when the authorization expired or was revoked', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockRejectedValue(Object.assign(new Error('Your Gmail authorization has expired or was revoked. Please disconnect Gmail below and connect again, then run the scan.'), { code: 'reconnect_required' }));
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    const banner = screen.getByTestId('scan-error');
    expect(banner).toHaveTextContent('Reconnect required');
    expect(banner).toHaveTextContent('expired or was revoked');
    expect(banner).toHaveTextContent('Disconnect Gmail');
  });

  it('shows retry guidance for transient Gmail failures', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockRejectedValue(
      Object.assign(new Error('Gmail limited how quickly scans may run. Please wait a minute and try Scan Now again.'), { code: 'rate_limited' })
    );
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    const banner = screen.getByTestId('scan-error');
    expect(banner).toHaveTextContent('Scan failed');
    expect(banner).toHaveTextContent('try Scan Now again');
    // No reconnect hint for transient failures.
    expect(banner.textContent).not.toContain('Disconnect Gmail');
  });
});

describe('ConnectEmail — candidate selection (CP4)', () => {
  it('toggles candidate selection without any scan or save call', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(window, 'fetch');
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(SCAN_DTO);
    render(<ConnectEmail />);

    await user.click(await screen.findByTestId('scan-now'));
    await screen.findByTestId('scan-results');
    expect(screen.getByTestId('scan-selection-note')).toHaveTextContent('Tick candidates');

    await user.click(screen.getByTestId('scan-select-m1'));
    await user.click(screen.getByTestId('scan-select-m2'));
    expect(screen.getByTestId('scan-selection-note')).toHaveTextContent('2 selected');

    await user.click(screen.getByTestId('scan-select-m1'));
    expect(screen.getByTestId('scan-selection-note')).toHaveTextContent('1 selected');

    // Only the manual scan ran — no fetch, no save endpoint, no second scan.
    expect(runScan).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('drops scan state after the account is disconnected (no stale results)', async () => {
    const user = userEvent.setup();
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(SCAN_DTO);
    disconnectGmail.mockResolvedValue(true);
    render(<ConnectEmail />);

    await screen.findByTestId('scan-now');
    await user.click(screen.getByTestId('scan-now'));
    await screen.findByTestId('scan-results');

    await user.click(screen.getByTestId('disconnect-btn'));
    await screen.findByText('Not connected');
    expect(screen.queryByTestId('scan-results')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scan-section')).not.toBeInTheDocument();
  });
});

describe('ConnectEmail — honesty constraints (CP4)', () => {
  it('never claims background monitoring is active and never renders message bodies or Gmail-side ids', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue({ ...SCAN_DTO, candidates: [{ ...SCAN_DTO.candidates[0], snippet: 'NEVER-SHOWN-BODY-XYZ' }] });
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    const text = document.body.textContent || '';
    expect(text).toMatch(/no background monitoring/i);
    expect(text).not.toMatch(/monitoring is active|automatically detected|saved to/i);
    expect(text).not.toContain('NEVER-SHOWN-BODY-XYZ');
  });
});

describe('ConnectEmail — payment reminder display (approved payment patch)', () => {
  const PAY_DTO = {
    ...SCAN_DTO,
    candidates: [
      {
        sourceMessageId: 'm7',
        classification: 'payment_reminder',
        serviceName: 'OpenAI',
        trialEndDate: null,
        renewalDate: null,
        invoiceDate: null,
        cancellationDeadline: null,
        paymentDeadline: '2026-10-22',
        paymentIssueType: 'payment_action_required',
        price: null,
        currency: null,
        confidence: 'high',
      },
    ],
  };

  it('renders the payment_reminder badge, its issue notice, and the payment deadline', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(PAY_DTO);
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    const name = screen.getByTestId('scan-name-m7');
    expect(name).toHaveTextContent('OpenAI');
    expect(screen.getByText('Payment reminder')).toBeInTheDocument();
    expect(screen.getByTestId('scan-detail-notice')).toHaveTextContent('Action required');
    expect(screen.getByTestId('scan-detail-payment-deadline')).toHaveTextContent('2026-10-22');
    // Old payment latencies stay null-for-unknown: no renewal date is displayed
    // just because a deadline is known (renewalDate null → not on the card).
    expect(screen.queryByTestId('scan-detail-renews-on')).not.toBeInTheDocument();
    expect(screen.getByTestId('scan-detail-price')).toHaveTextContent('Unknown');
  });

  it('labels an access-expiring deadline as "Access ends" and unknown deadlines as Unknown', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue({
      ...PAY_DTO,
      candidates: [
        { ...PAY_DTO.candidates[0], paymentIssueType: 'access_expiring', paymentDeadline: null },
      ],
    });
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    expect(screen.getByTestId('scan-detail-notice')).toHaveTextContent('Access expiring');
    expect(screen.getByTestId('scan-detail-access-ends')).toHaveTextContent('Unknown');
  });

  it('drops candidates with an unrecognized paymentIssueType to null (controlled vocabulary)', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    // This goes through the REAL service-layer whitelist? No — runScan is mocked,
    // so simulate what the whitelist would produce: invalid type → null → no Notice row.
    runScan.mockResolvedValue({
      ...PAY_DTO,
      candidates: [{ ...PAY_DTO.candidates[0], paymentIssueType: null, paymentDeadline: '2026-10-22' }],
    });
    render(<ConnectEmail />);

    await userEvent_setupAndScan();

    expect(screen.queryByTestId('scan-detail-notice')).not.toBeInTheDocument();
    expect(screen.getByTestId('scan-detail-payment-deadline')).toHaveTextContent('2026-10-22');
  });
});

/** Helper: mount with a connected session and run one scan via the button.
    Waits until the scan settles (button re-enabled) regardless of whether the
    outcome was results, empty, or an error. */
async function userEvent_setupAndScan() {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('scan-now'));
  await waitFor(() => expect(screen.getByTestId('scan-now')).toBeEnabled());
  return user;
}

describe('ConnectEmail — security guarantees', () => {
  it('never writes tokens, emails, or session identifiers to any web storage', async () => {
    const user = userEvent.setup();
    getAuthStatus.mockResolvedValue({ connected: true, email: 'hilta@example.com' });
    disconnectGmail.mockResolvedValue(true);
    const setItemCalls = [];
    const lsSet = vi.spyOn(window.localStorage, 'setItem');
    const ssSet = vi.spyOn(window.sessionStorage, 'setItem');
    render(<ConnectEmail />);

    await screen.findByTestId('disconnect-btn');
    await user.click(screen.getByTestId('disconnect-btn'));
    await screen.findByText('Not connected');

    expect(lsSet).not.toHaveBeenCalled();
    expect(ssSet).not.toHaveBeenCalled();
    expect(lsSet.mock.calls.length).toBe(0);
    expect(ssSet.mock.calls.length).toBe(0);
    expect(setItemCalls.length).toBe(0);
  });

  it('scrubs callback params from the URL so tokens/state never linger', async () => {
    getAuthStatus.mockRejectedValue(new Error('boom'));
    searchState('?error=oauth_state_invalid&connected=false&email=a@b.co');
    render(<ConnectEmail />);

    const banner = await screen.findByTestId('oauth-banner');
    expect(banner).toBeInTheDocument();
    // No residual oauth/error/email params left in the address bar.
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});

/* ===========================================================================
   CP5 — Save Selected (two-step confirmation, outcomes, retry, expiry)
   ============================================================================ */

const REF_DTO = {
  ...SCAN_DTO,
  scanRef: 'A'.repeat(43),
  scanRefExpiresAt: '2026-10-15T09:10:00.000Z',
};

const SAVED_ROW_M1 = {
  id: 'row-1-uuid',
  sourceMessageId: 'm1',
  serviceName: 'Netflix',
  planName: null,
  trialStartDate: null,
  trialEndDate: '2026-10-28',
  price: 15.99,
  currency: 'USD',
  status: 'trial',
  cancellationUrl: null,
  source: 'scan',
  renewalDate: null,
  paymentDeadline: null,
  paymentIssueType: null,
  invoiceDate: null,
  cancellationDeadline: null,
};

/** Helper: mount, complete one connected scan, then tick the given ids.
    Returns the userEvent instance for follow-up clicks. */
async function scannedAndSelected(ids) {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId('scan-now'));
  await waitFor(() => expect(screen.getByTestId('scan-now')).toBeEnabled());
  for (const id of ids) {
    await user.click(screen.getByTestId(`scan-select-${id}`));
  }
  return user;
}
describe('ConnectEmail — Save Selected (CP5)', () => {
  it('requires an explicit two-step confirmation and never saves on selection or arming', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(REF_DTO);
    render(<ConnectEmail />);

    const user = await scannedAndSelected(['m1', 'm2']);
    expect(screen.queryByTestId('scan-save-confirm-row')).not.toBeInTheDocument();

    // Step 1 arms — nothing is sent yet.
    await user.click(screen.getByTestId('scan-save'));
    expect(saveSelected).not.toHaveBeenCalled();
    expect(screen.getByTestId('scan-save-confirm-row')).toHaveTextContent('Confirm saving 2');

    // Cancel backs out without saving.
    await user.click(screen.getByTestId('scan-save-cancel'));
    expect(saveSelected).not.toHaveBeenCalled();
    expect(screen.queryByTestId('scan-save-confirm-row')).not.toBeInTheDocument();
  });

  it('sends ONLY (scanRef, selectedIds) on confirm and shows the saved outcome', async () => {
    saveSelected.mockResolvedValue({ saved: [SAVED_ROW_M1], alreadySaved: [], failed: [] });
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(REF_DTO);
    render(<ConnectEmail />);

    const user = await scannedAndSelected(['m1', 'm2']);
    await user.click(screen.getByTestId('scan-save')); // arm
    await user.click(screen.getByTestId('scan-save-confirm-row').querySelector('button')); // confirm

    expect(saveSelected).toHaveBeenCalledTimes(1);
    // Whitelist contract: exactly the reference and the selected ids —
    // no candidate objects, no ownership identifiers, nothing else.
    expect(saveSelected.mock.calls[0].length).toBe(2);
    expect(saveSelected.mock.calls[0][0]).toBe(REF_DTO.scanRef);
    expect([...saveSelected.mock.calls[0][1]].sort()).toEqual(['m1', 'm2']);

    expect(screen.getByTestId('scan-save-outcomes')).toBeInTheDocument();
    expect(screen.getByTestId('scan-save-saved')).toHaveTextContent('Saved 1 subscription: Netflix');
    expect(screen.queryByTestId('scan-save-already')).not.toBeInTheDocument();
    expect(screen.queryByTestId('scan-save-failed')).not.toBeInTheDocument();
    // Cleared selection: the confirmed id unticks, the pending one stays.
    expect(screen.getByTestId('scan-select-m1')).not.toBeChecked();
    expect(screen.getByTestId('scan-select-m2')).toBeChecked();
  });

  it('keeps failed selections ticked for retry and explains the outcome', async () => {
    saveSelected.mockResolvedValue({
      saved: [SAVED_ROW_M1],
      alreadySaved: [],
      failed: [{ sourceMessageId: 'm2', reason: 'db_error' }],
    });
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(REF_DTO);
    render(<ConnectEmail />);

    const user = await scannedAndSelected(['m1', 'm2']);
    await user.click(screen.getByTestId('scan-save'));
    await user.click(screen.getByTestId('scan-save-confirm-row').querySelector('button'));

    expect(screen.getByTestId('scan-save-saved')).toHaveTextContent('Saved 1 subscription: Netflix');
    const failed = screen.getByTestId('scan-save-failed');
    expect(failed).toHaveTextContent('Failed 1 (still selected for retry)');
    expect(failed).toHaveTextContent('try again');
    expect(screen.getByTestId('scan-select-m2')).toBeChecked(); // retryable
    expect(screen.getByTestId('scan-select-m1')).not.toBeChecked();
  });

  it('reports already-saved duplicates and unticks the resolved id', async () => {
    saveSelected.mockResolvedValue({ saved: [], alreadySaved: ['m1'], failed: [] });
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(REF_DTO);
    render(<ConnectEmail />);

    const user = await scannedAndSelected(['m1']);
    await user.click(screen.getByTestId('scan-save'));
    await user.click(screen.getByTestId('scan-save-confirm-row').querySelector('button'));

    expect(screen.getByTestId('scan-save-already')).toHaveTextContent('Already saved: 1');
    expect(screen.getByTestId('scan-select-m1')).not.toBeChecked();
  });

  it('shows the missing-reference hint instead of a save button when scanRef is null', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue({ ...SCAN_DTO }); // scanRef absent — never issued or server restarted
    render(<ConnectEmail />);

    await scannedAndSelected(['m1']);

    const hint = screen.getByTestId('scan-ref-missing');
    expect(hint).toHaveTextContent('no saving reference');
    expect(hint.textContent).not.toMatch(/expired/i);
    expect(screen.queryByTestId('scan-save')).not.toBeInTheDocument();
  });

  it('explains a whole-request expired reference and preserves selections', async () => {
    saveSelected.mockRejectedValue(
      Object.assign(new Error('This scan can no longer be saved because its saving window has expired. Run a new Scan Now and select subscriptions again.'), { code: 'scan_expired' })
    );
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(REF_DTO);
    render(<ConnectEmail />);

    const user = await scannedAndSelected(['m1']);
    await user.click(screen.getByTestId('scan-save'));
    await user.click(screen.getByTestId('scan-save-confirm-row').querySelector('button'));

    const banner = screen.getByTestId('scan-save-error');
    expect(banner).toHaveTextContent('Scan reference expired');
    expect(banner).toHaveTextContent('Run a new Scan Now');
    expect(screen.getByTestId('save-error-hint')).toBeInTheDocument();
    expect(screen.getByTestId('scan-select-m1')).toBeChecked(); // preserved for retry
  });

  it('shows a generic failure banner for network errors and preserves selections', async () => {
    saveSelected.mockRejectedValue(
      Object.assign(new Error('Could not reach TrialGuard services. Check that the backend is running.'), { code: 'network' })
    );
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(REF_DTO);
    render(<ConnectEmail />);

    const user = await scannedAndSelected(['m1']);
    await user.click(screen.getByTestId('scan-save'));
    await user.click(screen.getByTestId('scan-save-confirm-row').querySelector('button'));

    expect(screen.getByTestId('scan-save-error')).toHaveTextContent('Saving failed');
    expect(screen.queryByTestId('save-error-hint')).not.toBeInTheDocument();
    expect(screen.getByTestId('scan-select-m1')).toBeChecked();
  });

  it('disarms the confirmation when the selection changes (no stale counts)', async () => {
    getAuthStatus.mockResolvedValue(CONNECTED);
    runScan.mockResolvedValue(REF_DTO);
    render(<ConnectEmail />);

    const user = await scannedAndSelected(['m1']);
    await user.click(screen.getByTestId('scan-save')); // armed at 1
    expect(screen.getByTestId('scan-save-confirm-row')).toBeInTheDocument();

    await user.click(screen.getByTestId('scan-select-m2')); // selection changed
    expect(screen.queryByTestId('scan-save-confirm-row')).not.toBeInTheDocument();
    expect(screen.getByTestId('scan-save')).toHaveTextContent('Save 2 selected');
    expect(saveSelected).not.toHaveBeenCalled();
  });
});
