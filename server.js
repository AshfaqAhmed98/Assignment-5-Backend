const express = require("express");
const { connectToDatabase } = require("./lib/mongodb");
const {
  errorHandler,
  notFoundHandler,
} = require("./middleware/error-handler");

const app = express();
const port = Number(process.env.PORT || 3001);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

app.use(express.json());

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

app.use(notFoundHandler);
app.use(errorHandler);

async function startServer() {
  const { client, database } = await connectToDatabase();
  app.locals.database = database;

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
