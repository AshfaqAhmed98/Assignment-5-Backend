const { verifyAccessToken } = require("../lib/jwt");

function authenticate(req, _res, next) {
  const authorization = req.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);

  if (!match) {
    const error = new Error("A bearer token is required.");
    error.statusCode = 401;
    next(error);
    return;
  }

  try {
    const payload = verifyAccessToken(match[1]);

    if (typeof payload === "string" || typeof payload.sub !== "string") {
      const error = new Error("Invalid or expired access token.");
      error.statusCode = 401;
      next(error);
      return;
    }

    req.auth = { userId: payload.sub };
    next();
  } catch {
    const error = new Error("Invalid or expired access token.");
    error.statusCode = 401;
    next(error);
  }
}

module.exports = { authenticate };
