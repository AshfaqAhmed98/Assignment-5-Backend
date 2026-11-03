const { MongoClient } = require("mongodb");
const dns = require("node:dns");

async function connectToDatabase() {
  const configuredDnsServers = process.env.MONGODB_DNS_SERVERS;
  if (configuredDnsServers) {
    const dnsServers = configuredDnsServers
      .split(",")
      .map((server) => server.trim())
      .filter(Boolean);

    if (dnsServers.length === 0) {
      throw new Error("MONGODB_DNS_SERVERS must contain at least one DNS server.");
    }

    dns.setServers(dnsServers);
  }

  const configuredUri = process.env.MONGODB_URI?.trim();
  const hasWrappingQuotes =
    configuredUri &&
    ((configuredUri.startsWith('"') && configuredUri.endsWith('"')) ||
      (configuredUri.startsWith("'") && configuredUri.endsWith("'")));
  const uri = hasWrappingQuotes
    ? configuredUri.slice(1, -1).trim()
    : configuredUri;
  const databaseName = process.env.MONGODB_DATABASE;

  if (!uri) {
    throw new Error("MONGODB_URI must be set in Backend/.env.local.");
  }

  if (!/^mongodb(?:\+srv)?:\/\//.test(uri)) {
    throw new Error(
      'MONGODB_URI must start with "mongodb://" or "mongodb+srv://". Do not wrap it in quotes.',
    );
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
