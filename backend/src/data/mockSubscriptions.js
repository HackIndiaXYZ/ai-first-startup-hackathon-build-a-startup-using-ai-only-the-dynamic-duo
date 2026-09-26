// Mock subscription data — replace with Supabase queries in a future phase.
//
// Dates are computed relative to today so the demo scenarios remain realistic
// regardless of when the server is started. Do NOT replace these with hardcoded
// calendar dates again — that was the root cause of every status/stats bug.

function isoOffset(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const mockSubscriptions = [
  // --- Active trials expiring within 7 days (2) ---
  {
    id: '1a2b3c4d-0001',
    serviceName: 'StreamVault',
    planName: 'Premium Annual',
    trialStartDate: isoOffset(-7),
    trialEndDate: isoOffset(3),        // expires in 3 days
    price: 14.99,
    currency: 'USD',
    status: 'active',
    cancellationUrl: 'https://example-streamvault.fictitious/account/cancel',
  },
  {
    id: '1a2b3c4d-0002',
    serviceName: 'CloudMind AI',
    planName: 'Pro Seat',
    trialStartDate: isoOffset(-10),
    trialEndDate: isoOffset(6),        // expires in 6 days
    price: 29.99,
    currency: 'USD',
    status: 'active',
    cancellationUrl: 'https://example-cloudmind.fictitious/billing/cancel',
  },

  // --- Active trials expiring later (2) ---
  {
    id: '1a2b3c4d-0003',
    serviceName: 'NoteNest',
    planName: 'Team Starter',
    trialStartDate: isoOffset(-5),
    trialEndDate: isoOffset(21),       // expires in 3 weeks
    price: 9.99,
    currency: 'USD',
    status: 'active',
    cancellationUrl: 'https://example-notenest.fictitious/settings/subscription',
  },
  {
    id: '1a2b3c4d-0005',
    serviceName: 'DataSift Analytics',
    planName: 'Business Tier',
    trialStartDate: isoOffset(-3),
    trialEndDate: isoOffset(30),       // expires in 30 days
    price: 49.99,
    currency: 'USD',
    status: 'active',
    cancellationUrl: 'https://example-datasift.fictitious/plans/cancel',
  },

  // --- Expired trial — trial ended, not explicitly cancelled (1) ---
  {
    id: '1a2b3c4d-0006',
    serviceName: 'SecureVault',
    planName: 'Personal Shield',
    trialStartDate: isoOffset(-20),
    trialEndDate: isoOffset(-5),       // trial ended 5 days ago
    price: 4.99,
    currency: 'USD',
    status: 'active',                  // user never cancelled; status reflects account state
    cancellationUrl: 'https://example-securevault.fictitious/subscription/end',
  },

  // --- Confirmed cancelled subscription (1) ---
  {
    id: '1a2b3c4d-0004',
    serviceName: 'DesignSpark',
    planName: 'Creator Plus',
    trialStartDate: isoOffset(-30),
    trialEndDate: isoOffset(-15),      // trial ended 15 days ago; user cancelled
    price: 19.99,
    currency: 'USD',
    status: 'cancelled',
    cancellationUrl: 'https://example-designspark.fictitious/account/manage',
  },
];

module.exports = mockSubscriptions;
