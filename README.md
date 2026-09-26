# TrialGuard

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
