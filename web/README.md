# Vertical Farm Control PWA

A production-oriented Next.js App Router Progressive Web App for monitoring and operating a vertical farm environment. The UI is designed as a premium dark industrial dashboard with offline-capable shell caching, and a code structure prepared for Arduino Uno R3 serial ingestion and persistent history.

## Stack

- Next.js App Router
- TypeScript
- Recharts for interactive analytics
- Supabase for live sensor event reads
- Custom service worker for installability and offline shell behavior

## Local Development

1. Install dependencies:

```bash
npm ci
```

2. Configure environment:

```bash
cp .env.example .env.local
```

Fill in Supabase and serial values in `.env.local`.

3. Start the development server:

```bash
npm run dev
```

4. Build for production:

```bash
npm run build
npm run start
```

## Verification

Run the full handoff check before opening a pull request or handing off the repo:

```bash
npm run check
```

That runs lint, TypeScript, and production build validation.

## App Routes

- `/` - live dashboard
- `/history` - deterministic historical charts
- `/alerts` - current and stored alert review
- `/config` - deployment and ingestion readiness
- `/login` - operator sign-in
- `/api/sensor-events/latest` - latest Supabase sensor event
- `/api/config/status` - server-side environment and ingestion status

## Operator Sign-In

Every page and API route requires an operator signed in with Supabase Auth (email and password). Sessions are kept in cookies and refreshed on each request, so operators stay signed in for weeks. Sign out from **Settings**.

- **Vercel**: set `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Sign-in fails closed: with these missing, nobody gets in.
- **Farm Pi (LAN)**: set `AUTH_DISABLED=true`. The dashboard then skips sign-in and never contacts Supabase Auth, so it works with no internet. Only anyone already on the farm WiFi can reach it; do not port-forward it.
- **Supabase dashboard, once**: Authentication → Sign In / Providers → turn off *Allow new users to sign up*. Add each operator under Authentication → Users → *Add user*. Leave the session *time-box* and *inactivity timeout* off (or at 14 days or more).

Commands sent from the Farm page record the operator's email as `issued_by`.

## Arduino Live Ingestion

For the Arduino Uno R3 USB serial to Supabase live ingestion flow, see [`docs/live-ingestion.md`](./docs/live-ingestion.md).

## Deploy To Vercel

- Import the repository into Vercel as a Next.js project.
- Use Node.js 20 or newer.
- Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the project environment.
- The included [`vercel.json`](./vercel.json) sets cache behavior for the service worker, manifest, and `/images` assets so the PWA works cleanly in deployment.
- No custom server is required. Vercel can build and deploy the app directly with the default `next build` flow.

## Project Notes

- Fonts (IBM Plex Sans/Mono) are stored in [`src/app/fonts`](./src/app/fonts) and loaded with `next/font/local`, so `npm run build` and the running app need no internet access. This lets the dashboard be built and served on the farm's Raspberry Pi offline.

- Runtime visuals are served from [`public/images`](./public/images), which maps to the `/images` URL path used throughout the app.
- Supabase reads require explicit environment values. The app does not fall back to a bundled project key.
- The dashboard simulates live telemetry and persists the latest snapshot locally so the last known state still renders when offline.
- Mock telemetry is generated in a TypeScript `MockSensorGenerator` using the same top-level payload shape as the live sensor pipeline: `type`, `ts`, `device`, `seq`, `air`, `water`, `light`, and `level`.
- The history page uses deterministic time-series data for the selected farm context.
- The config page surfaces deployment readiness, recent ingestion, and device health.
