/**
 * useScanNow — TrialGuard Phase 3B CP4.
 *
 * State owner for the manual "Scan Now" flow on /connect-email:
 *   scanning      — request in flight (button disabled while true)
 *   results       — sanitized preview DTO (null until a completed scan)
 *   error         — { code, message } from scanApi (reconnect codes preserved)
 *   selectedIds   — Set of sourceMessageIds the user ticked for the future
 *                   "Save selected" feature; NEVER persisted, no endpoint is
 *                   called with it, and it resets on every new scan.
 *
 * No timing/interval logic exists here: a scan runs only when the component
 * calls scan(), which only the user's button click does (manual-by-design).
 */

import { useCallback, useState } from 'react';
import { runScan } from '../services/scanApi';
import { saveSelected } from '../services/saveApi';

export const SCAN_STATUS = {
  idle: 'idle',
  scanning: 'scanning',
  done: 'done',
  error: 'error',
};

export const SAVE_STATUS = {
  idle: 'idle',        // nothing pending; UI decides whether the button shows
  saving: 'saving',    // request in flight (button disabled while true)
  done: 'done',        // completed — outcome object is in saveOutcomes
  error: 'error',      // whole-request failure (scan_expired, network, …)
};

/** Verified against the backend contract: clearing is defensible only for ids
    the server reported as actually stored or already stored. */
function resolvedIds(outcomes) {
  return new Set([...outcomes.saved.map((r) => r.sourceMessageId ?? null)].filter(Boolean)
    .concat(outcomes.alreadySaved));
}

export function useScanNow() {
  const [status, setStatus] = useState(SCAN_STATUS.idle);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  // CP5-C: save state machine (explicit selection + confirmation upstream;
  // this hook only tracks the API round-trip and per-item outcomes).
  const [saveStatus, setSaveStatus] = useState(SAVE_STATUS.idle);
  const [saveOutcomes, setSaveOutcomes] = useState(null); // { saved, alreadySaved, failed }
  const [saveError, setSaveError] = useState(null);       // { code, message }

  const scan = useCallback(async () => {
    setStatus(SCAN_STATUS.scanning);
    setError(null);
    setSelectedIds(new Set()); // fresh scan → fresh selection
    setSaveStatus(SAVE_STATUS.idle); // fresh scan invalidates the old reference
    setSaveOutcomes(null);
    setSaveError(null);
    try {
      const dto = await runScan();
      setResults(dto);
      setStatus(SCAN_STATUS.done);
      return true;
    } catch (err) {
      setError({ code: err.code || 'network', message: err.message });
      setStatus(SCAN_STATUS.error);
      return false;
    }
  }, []);

  /**
   * Saves the currently selected candidates via { scanRef, messageIds } ONLY.
   * On per-item outcomes, selections clear ONLY for resolved ids (saved +
   * alreadySaved) — failed selections REMAIN ticked so the user can retry
   * (approved correction 7). Whole-request failures keep all selections.
   * @param {boolean} [includeIds] test hook — avoid; selections come from state
   */
  const save = useCallback(async () => {
    const dto = results;
    if (!dto?.scanRef || selectedIds.size === 0) return false;
    setSaveStatus(SAVE_STATUS.saving);
    setSaveError(null);
    try {
      const outcomes = await saveSelected(dto.scanRef, [...selectedIds]);
      setSaveOutcomes(outcomes);
      setSaveStatus(SAVE_STATUS.done);
      // Clear ONLY ids the backend confirmed (failure keeps selections ticked).
      const settled = resolvedIds(outcomes);
      if (settled.size > 0) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of settled) next.delete(id);
          return next;
        });
      }
      return true;
    } catch (err) {
      setSaveError({ code: err.code || 'network', message: err.message });
      setSaveStatus(SAVE_STATUS.error);
      return false; // selections preserved
    }
  }, [results, selectedIds]);

  const toggleCandidate = useCallback((sourceMessageId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sourceMessageId)) next.delete(sourceMessageId);
      else next.add(sourceMessageId);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);
  const clearError = useCallback(() => setError(null), []);

  /** Full reset — e.g., after the account is disconnected (results are stale). */
  const reset = useCallback(() => {
    setStatus(SCAN_STATUS.idle);
    setResults(null);
    setError(null);
    setSelectedIds(new Set());
    setSaveStatus(SAVE_STATUS.idle);
    setSaveOutcomes(null);
    setSaveError(null);
  }, []);

  return {
    status,
    results,
    error,
    selectedIds,
    scan,
    toggleCandidate,
    clearSelection,
    clearError,
    reset,
    // CP5-C
    saveStatus,
    saveOutcomes,
    saveError,
    save,
  };
}
