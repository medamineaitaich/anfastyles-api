# AnfaStyles API

Backend-only repo extracted from the original monorepo (`apps/api`).

## Commands

- Install: `npm ci` (or `npm install`)
- Dev (watch): `npm run dev`
- Start: `npm run start`

## Required env vars (deployment)

- `PORT` (optional): defaults to `3001`
- `CORS_ORIGIN` (recommended): frontend origin (e.g. `https://your-frontend.com`)
- `WC_STORE_URL` (required)
- `WC_CONSUMER_KEY` (required)
- `WC_CONSUMER_SECRET` (required)
