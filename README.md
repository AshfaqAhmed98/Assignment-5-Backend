# Assignment-5-Backend

## Run the server

From this directory, install dependencies and start the Express server:

```bash
npm install
npm run dev
```

The server listens on port `3001` by default. Set the `PORT` environment
variable to use a different port.

Backend environment variables belong in `.env.local` in this directory. The
start and development scripts load that file automatically. Keep it private
and do not commit it. Set `MONGODB_URI` to your MongoDB connection string and
`MONGODB_DATABASE` to the database name. The server connects to MongoDB before
it starts listening and exits with an error if it cannot connect. The
`/health` endpoint pings MongoDB and returns HTTP 503 if the database is
unavailable.

Unmatched routes and invalid JSON request bodies return consistent JSON error
responses through centralized Express middleware. Unexpected server errors are
logged by the backend and returned to clients without exposing internal details.

The backend currently provides MongoDB connectivity, health checks,
email/password authentication, and event creation, listing, joining, and
management endpoints.

## BetterAuth backend integration

BetterAuth is available as a parallel authentication API at
`/api/better-auth/*`. The existing `/api/auth/*` routes remain active so the
current frontend continues to work while it is migrated separately.

Set `BETTER_AUTH_URL` (the backend origin), `BETTER_AUTH_SECRET` (at least 32
bytes), `FRONTEND_ORIGIN`, and `GOOGLE_CLIENT_ID` plus `GOOGLE_CLIENT_SECRET`
in `.env.local`. `FRONTEND_ORIGIN` may contain multiple comma-separated
origins. Google sign-in in BetterAuth is enabled only when both provider
credentials are set. BetterAuth stores its users, sessions, accounts, and JWT
keys in its MongoDB collections and provides the JWT and JWKS endpoints under
`/api/better-auth`.

The current event API still authorizes requests using the legacy HS256 tokens
from `/api/auth/*`. BetterAuth users have not yet been linked to the existing
ObjectId-based event ownership records, so switching the frontend to
BetterAuth is a separate migration step.

## JWT authentication

Set `JWT_SECRET` in `.env.local` to a private random secret of at least 32
bytes. The backend requires it before starting and never returns it to clients.
Registration and login return a one-hour access JWT. Send it on protected
requests in the `Authorization` header using the `Bearer <token>` scheme.
`GET /api/auth/me` verifies the token and returns the current user. Refresh
tokens and logout/revocation are not implemented.

### Authentication endpoints

- `POST /api/auth/register` — JSON body: `{ "name", "email", "password" }`.
  Passwords must be 6–128 characters and include at least one uppercase and
  one lowercase letter. The password is hashed before it is stored in MongoDB.
- `POST /api/auth/login` — JSON body: `{ "email", "password" }`.
- `POST /api/auth/google` — JSON body: `{ "credential" }` containing the
  Google Identity Services ID token. The backend verifies the token audience,
  signature, expiry, and verified email using `GOOGLE_CLIENT_ID`; it creates
  an account on first sign-in. Existing email/password accounts must continue
  to use email/password sign-in; implicit account linking is not performed.
- `GET /api/auth/me` — requires a valid bearer token.

Emails are normalized to lowercase and uniquely indexed. Tokens use HS256 and
are checked for signature, issuer, audience, and expiration.
Registration and login accept only their documented fields; passwords are
limited to 128 characters.
Google accounts are uniquely indexed by Google subject ID.

## Event endpoints

- `POST /api/events` — requires a bearer token. Accepts a JSON body containing
  `{ "title", "description", "type", "thumbnailUrl", "location", "eventDate" }`
  with an HTTP/HTTPS thumbnail URL, or `multipart/form-data` with the same event
  fields and a JPG/PNG file in the `thumbnail` field. Uploaded thumbnails are
  limited to 50 MB and stored in MongoDB GridFS. They are served from
  `/api/events/images/:id`. `eventDate` must be a future ISO 8601 timestamp
  with a timezone. The event is saved with its creator's user ID and email;
  creator email is retained for assignment validation and is not included in
  public event responses. Clients may
  include an `Idempotency-Key` UUID header so retries of a completed creation
  return the original event instead of creating a duplicate.
- `GET /api/events` — public list of upcoming events sorted by event date
  ascending by default. Supports `page` (default `1`), `limit` (default `20`,
  maximum `100`), `sort` (`eventDate` or `createdAt`), and `order` (`asc` or
  `desc`). The response includes pagination totals.
- `GET /api/events/:id` — public event details by MongoDB ObjectId.
- `GET /api/events/:id/join` — requires a bearer token. Reports whether the
  current user has joined the event and whether they created it. Creators are
  not counted as attendees.
- `GET /api/events/mine` — requires a bearer token. Lists events created by
  the current user, newest first. Supports `page` (default `1`) and `limit`
  (default `20`, maximum `100`); the response includes pagination totals.
- `POST /api/events/:id/join` — requires a bearer token. Registers the current
  user for an upcoming event and returns the event snapshot. Creators cannot
  join their own events. Repeating an attendee's request returns the existing
  registration instead of creating a duplicate.
- `DELETE /api/events/:id/join` — requires a bearer token. Removes the current
  user's joined-event entry; repeating the request is safe.
- `GET /api/events/joined` — requires a bearer token. Returns the current
  user's joined event snapshots, newest registrations first. Supports `page`
  (default `1`) and `limit` (default `20`, maximum `100`); the response includes
  pagination totals. Joined events remain visible as snapshots if the original
  event is later updated or deleted.
- `PUT /api/events/:id` — requires a bearer token and the event creator's
  ownership. Replaces the event fields using the same JSON body and validation
  as event creation; responds with the updated event. Nonexistent events and
  events owned by another user both return `404`.
- `DELETE /api/events/:id` — requires a bearer token and the event creator's
  ownership. Returns `204` on success; nonexistent events and events owned by
  another user both return `404`.

Updates use the same validation, including a future ISO 8601 event date and
either an HTTP/HTTPS thumbnail URL or an existing GridFS thumbnail URL.
MongoDB indexes support upcoming-event and creation-date sorting.

## API request security

JSON request bodies are limited to 32 KB. Event create/update and auth
endpoints validate the request object, accept only documented fields, and
reject invalid types, lengths, dates, URLs, and pagination values. Event query
filters and sort fields are constructed server-side rather than taken directly
from request objects. Helmet adds standard HTTP security headers, API responses
are marked `Cache-Control: no-store`, and HSTS is enabled only when
`NODE_ENV=production`. Join registrations are protected by authentication and
a unique MongoDB index on user/event IDs, so concurrent duplicate requests
cannot create duplicate registrations.

To enable Google sign-in, set `GOOGLE_CLIENT_ID` in `Backend/.env.local` and
`NEXT_PUBLIC_GOOGLE_CLIENT_ID` in `Frontend/.env.local` to the same Google
OAuth web client ID. Add the frontend origin (for local development,
`http://localhost:3000`) to the OAuth client's authorized JavaScript origins.
The backend verifies Google ID tokens and does not need the OAuth client
secret for this flow. Never put `GOOGLE_CLIENT_SECRET` in a `NEXT_PUBLIC_`
variable.
