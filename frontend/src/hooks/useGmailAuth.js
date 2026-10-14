/**
 * useGmailAuth — TrialGuard Phase 3A C4.
 *
 * Derives the UI phase from the server-authoritative status endpoint:
 *   'checking'      — status request in flight (also between transitions)
 *   'connected'     — Gmail account attached to this browser, email known
 *   'not_connected' — signed cookie without a bound account (or none)
 *   'error'         — status lookup itself failed
 *
 * The hook never stores anything outside React state (no localStorage/
 * sessionStorage), and `disconnect` only flips to 'not_connected' after the
 * backend confirmed the deletion.
 */

import { useCallback, useEffect, useState } from 'react';
import { getAuthStatus, disconnectGmail } from '../services/authApi';

export const PHASE = {
  checking: 'checking',
  connected: 'connected',
  not_connected: 'not_connected',
  error: 'error',
};

export function useGmailAuth() {
  const [phase, setPhase] = useState(PHASE.checking);
  const [email, setEmail] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const refresh = useCallback(async () => {
    setPhase(PHASE.checking);
    setStatusError(null);
    try {
      const status = await getAuthStatus();
      if (status.connected && status.email) {
        setEmail(status.email);
        setPhase(PHASE.connected);
      } else {
        setEmail(null);
        setPhase(PHASE.not_connected);
      }
    } catch (err) {
      setEmail(null);
      setStatusError(err.message);
      setPhase(PHASE.error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await refresh();
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await disconnectGmail();
      setEmail(null);
      setStatusError(null);
      setPhase(PHASE.not_connected);
      return true;
    } catch (err) {
      setStatusError(err.message);
      return false;
    } finally {
      setDisconnecting(false);
    }
  }, []);

  return { phase, email, statusError, disconnecting, refresh, disconnect };
}
