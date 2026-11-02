const { MongoClient } = require("mongodb");

async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  const databaseName = process.env.MONGODB_DATABASE;

  if (!uri) {
    throw new Error("MONGODB_URI must be set in Backend/.env.local.");
  }

  if (!databaseName) {
    throw new Error("MONGODB_DATABASE must be set in Backend/.env.local.");
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const database = client.db(databaseName);
    await database.command({ ping: 1 });
    console.log(`Connected to MongoDB database "${databaseName}".`);

    return { client, database };
  } catch (error) {
    await client.close();
    throw error;
  }
}

module.exports = { connectToDatabase };
