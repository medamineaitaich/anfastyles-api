import express from 'express';

const app = express();

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'anfastyles-api', mode: 'minimal-test' });
});

const host = '0.0.0.0';
const port = process.env.PORT || 3001;

const server = app.listen(port, host, () => {
  console.log(`[startup] minimal-test listening on http://${host}:${port}`);
});

server.on('error', (error) => {
  console.error('[startup] listen error:', error?.stack || error);
  process.exit(1);
});
