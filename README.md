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

The current backend only establishes the database connection and exposes
health-check routes; application data endpoints have not been added yet.
