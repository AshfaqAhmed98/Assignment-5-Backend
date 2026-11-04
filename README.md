# EventMatrix Backend

The EventMatrix backend is an Express API using MongoDB. It provides
authentication and event services for the frontend.

## Run locally

Create `.env.local` in this directory with the required settings:

- `MONGODB_URI` and `MONGODB_DATABASE`
- `JWT_SECRET` — private random value of at least 32 bytes
- `BETTER_AUTH_URL` — frontend origin
- `BETTER_AUTH_SECRET` — private value of at least 32 bytes
- `FRONTEND_ORIGIN` — allowed frontend origin(s)

For Google sign-in, also configure `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET`. Keep secrets private and do not commit `.env.local`.

Install dependencies and start the backend:

```bash
npm install
npm run dev
```

The API listens on port `3001` by default. Check database connectivity at
[`http://localhost:3001/health`](http://localhost:3001/health).

## API overview

- `/api/auth/*` — authentication, session exchange, and profile images
- `/api/better-auth/*` — Better Auth sessions and OAuth
- `/api/events` — list and manage events
- `/api/events/:id/join` and `/api/events/joined` — join and list joined events
- `/api/events/mine` — events created by the signed-in user
- `/api/events/images/:id` — uploaded event thumbnails

Protected event routes require authentication. Event thumbnails support JPG
and PNG uploads up to 50 MB. Joined events are returned sorted by event date.

## Deploy

Deploy the backend to Vercel and configure the required environment variables
in the project settings. Set `BETTER_AUTH_URL` and `FRONTEND_ORIGIN` to the
deployed frontend origin, then verify the deployment at `/health`.
