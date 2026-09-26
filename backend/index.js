require('dotenv').config();
const express = require('express');
const cors = require('cors');
const errorHandler = require('./src/middleware/errorHandler');
const subscriptionsRouter = require('./src/routes/subscriptions');

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// Middleware
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TrialGuard API' });
});

// Routes
app.use('/api/subscriptions', subscriptionsRouter);

// 404 fallback for unknown API routes
app.use('/api/{*path}', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Global error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`TrialGuard API running on http://localhost:${PORT}`);
});
