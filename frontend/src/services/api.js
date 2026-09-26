/**
 * API service layer.
 * All backend requests go through here — swap the base URL for production via env.
 * Vite proxies /api/* to the Express backend in development (see vite.config.js).
 */

const BASE_URL = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function getSubscriptions() {
  return request('/subscriptions');
}

export function getSubscription(id) {
  return request(`/subscriptions/${id}`);
}

export function checkHealth() {
  return request('/health');
}
