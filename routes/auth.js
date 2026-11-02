const bcrypt = require("bcryptjs");
const express = require("express");
const { ObjectId } = require("mongodb");
const { authenticate } = require("../middleware/authenticate");
const { createAccessToken, tokenLifetime } = require("../lib/jwt");

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const minimumPasswordLength = 8;
const passwordSaltRounds = 12;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createAuthResponse(user) {
  return {
    token: createAccessToken(user._id.toString()),
    tokenType: "Bearer",
    expiresIn: tokenLifetime,
    user: {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
    },
  };
}

function createAuthRouter() {
  const router = express.Router();

  router.post("/register", async (req, res) => {
    const users = req.app.locals.database.collection("users");
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const email =
      typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";

    if (!name || name.length > 80) {
      throw createHttpError("Name is required and must be 80 characters or fewer.", 400);
    }

    if (!emailPattern.test(email) || email.length > 254) {
      throw createHttpError("A valid email address is required.", 400);
    }

    if (password.length < minimumPasswordLength || password.length > 128) {
      throw createHttpError(
        `Password must be between ${minimumPasswordLength} and 128 characters.`,
        400,
      );
    }

    const passwordHash = await bcrypt.hash(password, passwordSaltRounds);
    const user = {
      name,
      email,
      passwordHash,
      createdAt: new Date(),
    };

    try {
      const result = await users.insertOne(user);
      user._id = result.insertedId;
    } catch (error) {
      if (error.code === 11000) {
        throw createHttpError("An account with this email already exists.", 409);
      }

      throw error;
    }

    res.status(201).json(createAuthResponse(user));
  });

  router.post("/login", async (req, res) => {
    const users = req.app.locals.database.collection("users");
    const email =
      typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password =
      typeof req.body?.password === "string" ? req.body.password : "";

    if (!emailPattern.test(email) || !password) {
      throw createHttpError("Email or password is incorrect.", 401);
    }

    const user = await users.findOne({ email });
    const passwordMatches = user
      ? await bcrypt.compare(password, user.passwordHash)
      : false;

    if (!passwordMatches) {
      throw createHttpError("Email or password is incorrect.", 401);
    }

    res.json(createAuthResponse(user));
  });

  router.get("/me", authenticate, async (req, res) => {
    const users = req.app.locals.database.collection("users");
    if (!ObjectId.isValid(req.auth.userId)) {
      throw createHttpError("Invalid or expired access token.", 401);
    }

    const user = await users.findOne(
      { _id: new ObjectId(req.auth.userId) },
      { projection: { name: 1, email: 1 } },
    );

    if (!user) {
      throw createHttpError("Invalid or expired access token.", 401);
    }

    res.json({
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
      },
    });
  });

  return router;
}

module.exports = { createAuthRouter };
