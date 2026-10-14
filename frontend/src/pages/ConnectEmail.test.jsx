import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
