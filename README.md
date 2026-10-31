# TrialGuard
> HackIndia submission by **The Dynamic Duo** — AI-First Startup Hackathon. Team tag: `hackindia-team:ai-first-startup-hackathon-build-a-startup-using-ai-only:the-dynamic-duo`


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

## How AI was used

I built TrialGuard with AI tools in stages:

| Stage | Tool | What it did |
|---|---|---|
| 1 | ChatGPT | Wrote the prompts I gave to the coding tool, diagnosed problems and planned fixes in the earlier phases (up to 26 Oct). |
| 2 | Freebuff | AI coding agent that wrote the code from those prompts.  The dashboard, the Supabase setup, the Gmail sign-in. |
| 3 | IBM Bob | AI coding agent in the IDE. It read the code in a read-only mode and made edits in an edit mode. I approved every edit by hand and kept auto-approve off. |
| 4 | Claude | From 26 Oct: planned the work, found the causes of bugs, wrote the prompts I gave to Bob, and helped me read test results. |

### Work done with ChatGPT and Freebuff (before 26 Oct)

- Found out why the dashboard showed only sample rows. The login cookie was already being sent, so no change was needed there.
- Fixed saves being reported as "already saved" when they had worked: the database insert did not return the new row.
- Added server logging for scan-reference problems, without logging the reference itself.
- Fixed a dashboard crash caused by a saved item with no price (missing values are now handled safely).
- Made an item with no end date show "Status unknown" instead of "active".
- Added tests for these fixes, and wrote the plan for reading email bodies.

### Work done with Claude and IBM Bob (26 to 31 Oct)

- Built the email-body reader and made dates and prices come from the body when it is available.
- Added 31 tests for the body reader and 22 tests for the new date and payment rules, all using invented emails.
- Replaced a misleading "saving window expired" message with two clearer messages and tests.
- Connected the backend tests to `npm test`.
- Ran a real end-to-end test on my own mailbox.

### How a human stayed in control

- I ran every test myself in a separate terminal and did not rely on an AI's claim that a test
  would pass. Once Bob said a test would pass; running it showed it failed. We tested the cause with
  small scripts and fixed the test wording, not the rule.
- Safety rules for the AI tools: no secrets read, no database reset, no migrations, no Gmail scans
  by the tool, and no commit or push without my approval.
- I checked the real emails in Gmail by hand. This showed that a "Payment failed, deadline Unknown"
  result was correct, because that email states no date.
- The end-to-end test: scan, save one item, check the dashboard, and save the same item again
  (reported as already saved).

Planning notes written with AI help are in `gmail-integration-plan.md` and `cp5-save-selected-plan.md`.   

## Roadmap: AI-assisted extraction

Today the detection is rule-based. The next step is an **opt-in** AI helper, off by default, that would
fill only the fields the rules left Unknown. Design rules, decided before building:

- The AI must return an exact quote from the email as proof, and the app checks that the quote is really in the text.
- It never changes a value the rules already found, and never changes the category.
- Email text is cleaned first (addresses, links and long numbers removed), capped in length, and never stored.
- Every AI-filled field is badged "AI-suggested" so the user checks it.
- If the AI fails, the rules' result is kept.

It is not built yet. We chose to ship a reliable, tested rule-based version, and to add the AI helper only with
a privacy review.

### Not yet done

- Testing with a second account (to confirm one user cannot see another user's saved rows).
- AI-assisted extraction (would send email text to an outside service, which needs a privacy decision).
- Reminders, notifications and the My Subscriptions page.