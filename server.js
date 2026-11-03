const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const { connectToDatabase } = require("./lib/mongodb");
const { getJwtSecret } = require("./lib/jwt");
const {
  createBetterAuth,
  getFrontendOrigins,
} = require("./lib/better-auth");
const { createAuthRouter } = require("./routes/auth");
const { createEventsRouter } = require("./routes/events");
const { errorHandler, notFoundHandler } = require("./middleware/error-handler");

const app = express();
const port = Number(process.env.PORT || 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

app.use(
  helmet({
    hsts:
      process.env.NODE_ENV === "production"
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
  }),
);
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
async function startServer() {
  getJwtSecret();
  const { client, database } = await connectToDatabase();
  app.locals.database = database;
  try {
    const auth = await createBetterAuth(database);
    const { toNodeHandler } = await import("better-auth/node");
    app.locals.betterAuth = auth;
    app.use(
      cors({
        origin: getFrontendOrigins(),
        credentials: true,
      }),
    );
    const betterAuthHandler = toNodeHandler(auth);
    app.all("/api/better-auth/*splat", betterAuthHandler);
    app.all("/api/better-auth", betterAuthHandler);
    app.all("/api/auth/dash/*splat", (req, res, next) => {
      req.url = req.url.replace(
        /^\/api\/auth\/dash(?=\/|$)/,
        "/api/better-auth/dash",
      );
      return betterAuthHandler(req, res, next);
    });
    app.use(express.json({ limit: "32kb" }));

    app.get("/", (_req, res) => {
      res.json({ message: "Backend server is running" });
    });

    app.get("/health", async (_req, res) => {
      try {
        await app.locals.database.command({ ping: 1 });
        res.json({ status: "ok", database: "connected" });
      } catch (error) {
        error.statusCode = 503;
        throw error;
      }
    });

    app.use("/api/auth", createAuthRouter());
    app.use("/api/events", createEventsRouter());
    app.use(notFoundHandler);
    app.use(errorHandler);

    await Promise.all([
      database
        .collection("users")
        .createIndex({ email: 1 }, { unique: true, name: "users_email_unique" }),
      database.collection("users").createIndex(
        { googleId: 1 },
        { unique: true, sparse: true, name: "users_google_id_unique" },
      ),
      database.collection("events").createIndex(
        { eventDate: 1, _id: 1 },
        { name: "events_upcoming_by_date" },
      ),
      database.collection("events").createIndex(
        { createdAt: -1, _id: -1 },
        { name: "events_by_created_at" },
      ),
      database.collection("events").createIndex(
        { createdBy: 1, creationRequestId: 1 },
        {
          unique: true,
          name: "events_creation_request_unique",
          partialFilterExpression: {
            creationRequestId: { $type: "string" },
          },
        },
      ),
      database.collection("eventJoins").createIndex(
        { userId: 1, eventId: 1 },
        { unique: true, name: "event_joins_user_event_unique" },
      ),
      database.collection("eventJoins").createIndex(
        { userId: 1, joinedAt: -1, _id: -1 },
        { name: "event_joins_by_user_and_date" },
      ),
    ]);
  } catch (error) {
    await client.close();
    throw error;
  }

  const server = app.listen(port, () => {
    console.log(`Express server listening on port ${port}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      console.log(`${signal} received; closing the server.`);
      server.close(async (error) => {
        try {
          await client.close();
        } catch (closeError) {
          console.error("Unable to close the MongoDB connection:", closeError);
          process.exitCode = 1;
        }

        if (error) {
          console.error("Unable to close the HTTP server:", error);
          process.exitCode = 1;
        }
      });
    });
  }
}

startServer().catch((error) => {
  console.error("Unable to start the backend:", error);
  process.exitCode = 1;
});
