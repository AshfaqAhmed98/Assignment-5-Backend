function getFrontendOrigins() {
  const configuredOrigins = process.env.FRONTEND_ORIGIN;

  if (!configuredOrigins) {
    throw new Error("FRONTEND_ORIGIN must be set in Backend/.env.local.");
  }

  const origins = configuredOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error("FRONTEND_ORIGIN must include at least one valid origin.");
  }

  const normalizedOrigins = origins.map((origin) => {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new Error("Every FRONTEND_ORIGIN entry must be a valid URL.");
    }

    if (
      !["http:", "https:"].includes(parsedOrigin.protocol) ||
      parsedOrigin.pathname !== "/" ||
      parsedOrigin.search ||
      parsedOrigin.hash ||
      parsedOrigin.username ||
      parsedOrigin.password
    ) {
      throw new Error(
        "Every FRONTEND_ORIGIN entry must be an HTTP or HTTPS origin without a path.",
      );
    }

    return parsedOrigin.origin;
  });

  return [...new Set([...normalizedOrigins, "https://dash.better-auth.com"])];
}

async function createBetterAuth(database) {
  const { betterAuth } = await import("better-auth");
  const { mongodbAdapter } = await import("better-auth/adapters/mongodb");
  const { jwt } = await import("better-auth/plugins");
  const { dash } = await import("@better-auth/infra");

  const baseURL = process.env.BETTER_AUTH_URL?.trim();
  const secret = process.env.BETTER_AUTH_SECRET;
  const frontendOrigins = getFrontendOrigins();
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!baseURL) {
    throw new Error("BETTER_AUTH_URL must be set in Backend/.env.local.");
  }

  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("BETTER_AUTH_SECRET must be set to at least 32 bytes.");
  }

  let parsedBaseURL;
  try {
    parsedBaseURL = new URL(baseURL);
  } catch {
    throw new Error("BETTER_AUTH_URL must be a valid URL.");
  }

  if (
    !["http:", "https:"].includes(parsedBaseURL.protocol) ||
    parsedBaseURL.pathname !== "/" ||
    parsedBaseURL.search ||
    parsedBaseURL.hash ||
    parsedBaseURL.username ||
    parsedBaseURL.password
  ) {
    throw new Error("BETTER_AUTH_URL must be an HTTP or HTTPS origin.");
  }

  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set to enable BetterAuth Google sign-in.",
    );
  }

  return betterAuth({
    baseURL: parsedBaseURL.toString().replace(/\/$/, ""),
    basePath: "/api/better-auth",
    secret,
    database: mongodbAdapter(database),
    trustedOrigins: frontendOrigins,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 6,
      maxPasswordLength: 128,
    },
    account: {
      accountLinking: {
        trustedProviders: ["google"],
        requireLocalEmailVerified: false,
      },
    },
    ...(googleClientId
      ? {
          socialProviders: {
            google: {
              clientId: googleClientId,
              clientSecret: googleClientSecret,
              overrideUserInfoOnSignIn: true,
            },
          },
        }
      : {}),
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      dash({ apiKey: process.env.BETTER_AUTH_API_KEY }),
    ],
  });
}

module.exports = { createBetterAuth, getFrontendOrigins };
