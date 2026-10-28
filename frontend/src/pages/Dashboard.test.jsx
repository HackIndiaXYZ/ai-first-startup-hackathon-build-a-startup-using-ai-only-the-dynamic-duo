import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import Dashboard from './Dashboard';

/* The Dashboard test only needs the list the service returns — the network is
   never touched. getSubscriptions returns the exact client shape the backend
   mapper emits (camelCase + `source`). */
vi.mock('../services/api', () => ({
  getSubscriptions: vi.fn(),
}));

import { getSubscriptions } from '../services/api';

function demoRow(id, serviceName) {
  return {
    id,
    serviceName,
    planName: 'Sample Plan',
    trialStartDate: '2026-09-14',
    trialEndDate: '2026-10-20',
    price: 9.99,
    currency: 'USD',
    status: 'active',
    cancellationUrl: null,
    source: 'demo',
    sourceMessageId: null,
    renewalDate: null,
    paymentDeadline: null,
    paymentIssueType: null,
    invoiceDate: null,
    cancellationDeadline: null,
  };
}

const SIX_DEMO = [
  demoRow('d1', 'StreamVault'),
  demoRow('d2', 'CloudMind AI'),
  demoRow('d3', 'NoteNest'),
  demoRow('d4', 'DataSift Analytics'),
  demoRow('d5', 'SecureVault'),
  demoRow('d6', 'DesignSpark'),
];

const USER_SAVED = {
  id: 'u1',
  serviceName: 'Netflix',
  planName: null,
  trialStartDate: null,
  trialEndDate: '2026-11-20',
  price: 15.99,
  currency: 'USD',
  status: 'trial',
  cancellationUrl: null,
  source: 'scan',
  sourceMessageId: 'abc',
  renewalDate: null,
  paymentDeadline: null,
  paymentIssueType: null,
  invoiceDate: null,
  cancellationDeadline: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('Dashboard — demo data separation (CP5)', () => {
  it('shows the six demo records under their own clearly labeled section', async () => {
    getSubscriptions.mockResolvedValue(SIX_DEMO);
    render(<Dashboard />);

    const demoSection = await screen.findByText('Demo data');
    expect(demoSection).toBeInTheDocument();
    expect(screen.queryByText('Saved from Gmail')).not.toBeInTheDocument();
    expect(screen.getByText(/Fictional sample subscriptions included with TrialGuard/)).toBeInTheDocument();

    // All six seeded records are still rendered, with their real names.
    for (const name of ['StreamVault', 'CloudMind AI', 'NoteNest', 'DataSift Analytics', 'SecureVault', 'DesignSpark']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('renders saved-from-Gmail subscriptions in a separate section from demo rows', async () => {
    getSubscriptions.mockResolvedValue([...SIX_DEMO, USER_SAVED]);
    render(<Dashboard />);

    const savedHeading = await screen.findByText('Saved from Gmail');
    expect(savedHeading).toBeInTheDocument();
    expect(screen.getByText('Demo data')).toBeInTheDocument();

    // The saved Netflix appears ONLY under the saved section, and all six
    // demo rows stay in the demo section — no mixing.
    const savedSection = savedHeading.closest('section');
    expect(within(savedSection).getByText('Netflix')).toBeInTheDocument();
    expect(within(savedSection).queryByText('StreamVault')).not.toBeInTheDocument();

    const demoSection = screen.getByText('Demo data').closest('section');
    for (const name of ['StreamVault', 'CloudMind AI', 'NoteNest', 'DataSift Analytics', 'SecureVault', 'DesignSpark']) {
      expect(within(demoSection).getByText(name)).toBeInTheDocument();
    }
    expect(within(demoSection).queryByText('Netflix')).not.toBeInTheDocument();
  });

  it('labels the saved section as coming from the user\'s own mailbox only', async () => {
    getSubscriptions.mockResolvedValue([USER_SAVED]);
    render(<Dashboard />);

    const savedHeading = await screen.findByText('Saved from Gmail');
    const savedSection = savedHeading.closest('section');
    expect(within(savedSection).getByText(/Connect Email page/i)).toBeInTheDocument();
    expect(screen.queryByText('Demo data')).not.toBeInTheDocument();
  });

  it('renders a saved-from-Gmail subscription with null price and null date without crashing', async () => {
    const nullFieldSub = {
      id: 'u2',
      serviceName: 'SomeApp',
      planName: null,
      trialStartDate: null,
      trialEndDate: null,
      price: null,
      currency: null,
      status: 'trial',
      cancellationUrl: null,
      source: 'scan',
      sourceMessageId: 'xyz',
      renewalDate: null,
      paymentDeadline: null,
      paymentIssueType: null,
      invoiceDate: null,
      cancellationDeadline: null,
    };
    getSubscriptions.mockResolvedValue([nullFieldSub]);
    render(<Dashboard />);

    //page must render and the card must show "Unknown" for price and date fields
    await screen.findByText('SomeApp');
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(1);
    //status part: null trialEndDate must show neutral badge, not count as active trial
    expect(screen.getByText('Status unknown')).toBeInTheDocument();
    expect(screen.getByText('Active free trials').previousSibling.textContent).toBe('0');
  });
});
