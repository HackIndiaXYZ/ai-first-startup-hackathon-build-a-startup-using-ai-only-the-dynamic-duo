# TrialGuard
> HackIndia submission by **The Dynamic Duo** — AI-First Startup Hackathon. Team tag: `hackindia-team:ai-first-startup-hackathon-build-a-startup-using-ai-only:the-dynamic-duo`

AI-powered subscription and free-trial management agent — Vibe Coding Hackathon 2026.

## Phase 1 — Working Dashboard

Phase 1 delivers a responsive dashboard backed by a real Express API serving mock subscription data.

### Prerequisites

- Node.js 18+
- npm

---

## Running the project

### 1. Start the backend

```bash
cd backend
node index.js
# or, with auto-reload:
npm run dev
```

The API will be available at `http://localhost:3001`.

### 2. Start the frontend

Open a second terminal:

```bash
cd frontend
npm run dev
```

The dashboard will be available at `http://localhost:5173`.

---

## API endpoints (Phase 1)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness check |
| GET | `/api/subscriptions` | List all mock subscriptions |
| GET | `/api/subscriptions/:id` | Get a single subscription |

---

## Project structure

```
TrialGuard/
├── backend/
│   ├── index.js                  ← Express entry point
│   ├── .env.example
│   └── src/
│       ├── data/
│       │   └── mockSubscriptions.js
│       ├── middleware/
│       │   └── errorHandler.js
│       └── routes/
│           └── subscriptions.js
│
└── frontend/
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── App.jsx
        ├── App.css
        ├── index.css
        ├── main.jsx
        ├── components/
        │   ├── Sidebar.jsx / .css
        │   ├── StatusBadge.jsx / .css
        │   ├── SubscriptionCard.jsx / .css
        │   ├── SubscriptionModal.jsx / .css
        │   └── StatsSummary.jsx / .css
        ├── pages/
        │   ├── Dashboard.jsx / .css
        ├── hooks/
        │   └── useSubscriptions.js
        └── services/
            └── api.js
```

---

## Tech stack

- **Frontend**: React 19 + Vite 8, plain CSS
- **Backend**: Node.js + Express 5, CORS, dotenv
- **Database**: Supabase (Phase 2+)
- **Email**: Gmail API OAuth 2.0 (Phase 2+)
- **AI**: External AI model (Phase 3+)
## What TrialGuard does and does not do

TrialGuard scans Gmail on request (read-only) and lists emails that look like free trials,
subscriptions, renewals, receipts, payment problems and access-expiry notices.

**Detection is rule-based (keywords and date/price patterns). It is not AI.**
Where an email does not state a date, price or status, TrialGuard shows "Unknown" and never guesses.

### Known limitations

1. Scan coverage is capped. Three Gmail searches return up to 25 emails each, 25 conversations are
   inspected, and at most 16 are read in full. The page warns that results may be incomplete.
2. Dates and prices are found only next to phrases the rules recognise (for example "lose access on",
   "trial ends on"). Other wording leaves the field Unknown.
3. Emails about a trial that has already expired ("your trial has expired") are not detected.
4. The service name comes from the sender's display name, so it can be a person's name.
5. Repeated emails about the same issue (for example several identical reminders) appear as separate
   candidates and are not grouped.
6. A saved payment reminder is shown on the dashboard with trial-style fields (Unknown where not
   applicable). Payment-specific details are not yet shown there.
7. A scan can be saved for about 10 minutes. The saving reference lives in server memory, so a server
   restart makes the user scan again.
8. Email text (subject, preview and a limited part of the body) is read while scanning but is never
   stored, logged or sent to the browser.

### Not yet done

- Testing with a second account (to confirm one user cannot see another user's saved rows).
- AI-assisted extraction (would send email text to an outside service, which needs a privacy decision).
- Reminders, notifications and the My Subscriptions page.