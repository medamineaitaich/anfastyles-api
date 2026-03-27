import express from 'express';
import productsRouter from './routes/products.js';

const app = express();

// Root health/smoke route (keep this working)
app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'anfastyles-api', mode: 'products-only' });
});

// Products-only API slice
app.use('/products', (req, _res, next) => {
  console.log(`[req] ${req.method} ${req.originalUrl}`);
  next();
});
app.use('/products', productsRouter);

// Minimal error handler so async route errors return JSON (instead of crashing or hanging)
app.use((err, _req, res, _next) => {
  console.error('[error]', err?.stack || err);
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

const host = '0.0.0.0';
const port = process.env.PORT || 3001;

const server = app.listen(port, host, () => {
  console.log(`[startup] products-only listening on http://${host}:${port}`);
});

server.on('error', (error) => {
  console.error('[startup] listen error:', error?.stack || error);
  process.exit(1);
});
