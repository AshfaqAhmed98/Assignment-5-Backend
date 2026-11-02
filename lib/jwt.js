const jwt = require("jsonwebtoken");

const issuer = "assignment-5-backend";
const audience = "assignment-5-frontend";
const tokenLifetime = "1h";

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("JWT_SECRET must be set to at least 32 bytes.");
  }

  return secret;
}

function createAccessToken(userId) {
  return jwt.sign({}, getJwtSecret(), {
    algorithm: "HS256",
    audience,
    expiresIn: tokenLifetime,
    issuer,
    subject: userId,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, getJwtSecret(), {
    algorithms: ["HS256"],
    audience,
    issuer,
  });
}

module.exports = {
  createAccessToken,
  getJwtSecret,
  tokenLifetime,
  verifyAccessToken,
};
