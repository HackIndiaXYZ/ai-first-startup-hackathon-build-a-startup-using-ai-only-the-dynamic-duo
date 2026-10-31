require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const errorHandler = require('./src/middleware/errorHandler');
const subscriptionsRouter = require('./src/routes/subscriptions');
const authRouter = require('./src/routes/auth');
const scanRouter = require('./src/routes/scan');

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

// Trust the first proxy hop in production (required for req.secure and
// correct IP on Render and similar reverse-proxy hosts).
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TrialGuard API' });
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/scan', scanRouter);

// 404 fallback for unknown API routes
app.use('/api/{*path}', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Serve the built frontend in production; fall back to index.html for
// client-side routes. Placed after all /api handlers so API routes
// always take precedence.
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../frontend/dist')));
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
  });
}

// Global error handler
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TrialGuard API running on http://localhost:${PORT}`);
  });
}

module.exports = { app };
