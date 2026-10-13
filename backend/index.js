require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const errorHandler = require('./src/middleware/errorHandler');
const subscriptionsRouter = require('./src/routes/subscriptions');
const authRouter = require('./src/routes/auth');

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// Middleware
app.use(cors({
  origin: CORS_ORIGIN,
  // The OAuth callback is a top-level navigation (no CORS needed), but the
  // frontend calls /api/auth/* via the Vite proxy — same-origin to the browser.
  credentials: true,
}));
app.use(express.json());
// Signed cookies: SESSION_SECRET signs trialguard_session; secrets stay server-side.
app.use(cookieParser(process.env.SESSION_SECRET));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TrialGuard API' });
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api/subscriptions', subscriptionsRouter);

// 404 fallback for unknown API routes
app.use('/api/{*path}', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TrialGuard API running on http://localhost:${PORT}`);
  });
}

module.exports = { app };
