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
email/password authentication, and event creation/list/detail endpoints.

## JWT authentication

Set `JWT_SECRET` in `.env.local` to a private random secret of at least 32
bytes. The backend requires it before starting and never returns it to clients.
Registration and login return a one-hour access JWT. Send it on protected
requests in the `Authorization` header using the `Bearer <token>` scheme.
`GET /api/auth/me` verifies the token and returns the current user. Refresh
tokens and logout/revocation are not implemented.

### Authentication endpoints

- `POST /api/auth/register` — JSON body: `{ "name", "email", "password" }`.
  Passwords must be 8–128 characters. The password is hashed before it is
  stored in MongoDB.
- `POST /api/auth/login` — JSON body: `{ "email", "password" }`.
- `GET /api/auth/me` — requires a valid bearer token.

Emails are normalized to lowercase and uniquely indexed. Tokens use HS256 and
are checked for signature, issuer, audience, and expiration.

## Event endpoints

- `POST /api/events` — requires a bearer token. JSON body: `{ "title",
  "description", "type", "thumbnailUrl", "location", "eventDate" }`.
  `eventDate` must be a future ISO 8601 timestamp with a timezone. The event is
  saved with its creator's user ID.
- `GET /api/events` — public list of upcoming events sorted by event date
  ascending by default. Supports `page` (default `1`), `limit` (default `20`,
  maximum `100`), `sort` (`eventDate` or `createdAt`), and `order` (`asc` or
  `desc`). The response includes pagination totals.
- `GET /api/events/:id` — public event details by MongoDB ObjectId.
- `PUT /api/events/:id` — requires a bearer token and the event creator's
  ownership. Replaces the event fields using the same JSON body and validation
  as event creation; responds with the updated event. Nonexistent events and
  events owned by another user both return `404`.
- `DELETE /api/events/:id` — requires a bearer token and the event creator's
  ownership. Returns `204` on success; nonexistent events and events owned by
  another user both return `404`.

Creation currently accepts an HTTP or HTTPS thumbnail URL; file uploads are
not implemented. Updates use the same validation, including a future
ISO 8601 event date and HTTP/HTTPS thumbnail URL. MongoDB indexes support
upcoming-event and creation-date sorting.
