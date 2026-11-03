const bcrypt = require("bcryptjs");
const express = require("express");
const { ObjectId } = require("mongodb");
const { authenticate } = require("../middleware/authenticate");
const { createAccessToken, tokenLifetime } = require("../lib/jwt");
const { OAuth2Client } = require("google-auth-library");

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const minimumPasswordLength = 6;
const passwordSaltRounds = 12;
const maximumGoogleCredentialLength = 8192;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function validateRequestBody(body, allowedFields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError("A JSON object is required.", 400);
  }

  const unexpectedField = Object.keys(body).find(
    (field) => !allowedFields.includes(field),
  );
  if (unexpectedField) {
    throw createHttpError("Request contains an unsupported field.", 400);
  }

  return body;
}

function validatePhotoURL(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    throw createHttpError("A valid profile photo URL is required.", 400);
  }

  let photoURL;
  try {
    photoURL = new URL(value.trim());
  } catch {
    throw createHttpError("A valid profile photo URL is required.", 400);
  }

  if (!["http:", "https:"].includes(photoURL.protocol)) {
    throw createHttpError("Profile photo URLs must use HTTP or HTTPS.", 400);
  }

  return photoURL.toString();
}

function getGooglePhotoURL(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    return undefined;
  }

  try {
    const photoURL = new URL(value.trim());
    return ["http:", "https:"].includes(photoURL.protocol)
      ? photoURL.toString()
      : undefined;
  } catch {
    return undefined;
  }
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
      ...(typeof user.photoURL === "string" ? { photoURL: user.photoURL } : {}),
    },
  };
}

function validateGoogleCredential(body) {
  const validatedBody = validateRequestBody(body, ["credential"]);
  if (
    typeof validatedBody.credential !== "string" ||
    !validatedBody.credential ||
    validatedBody.credential.length > maximumGoogleCredentialLength
  ) {
    throw createHttpError("A valid Google credential is required.", 400);
  }

  return validatedBody.credential;
}

function createAuthRouter() {
  const router = express.Router();

  router.post("/register", async (req, res) => {
    const body = validateRequestBody(req.body, [
      "name",
      "email",
      "password",
      "photoURL",
    ]);
    const users = req.app.locals.database.collection("users");
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password =
      typeof body.password === "string" ? body.password : "";
    const photoURL =
      body.photoURL === undefined ? undefined : validatePhotoURL(body.photoURL);

    if (!name || name.length > 80) {
      throw createHttpError("Name is required and must be 80 characters or fewer.", 400);
    }

    if (!emailPattern.test(email) || email.length > 254) {
      throw createHttpError("A valid email address is required.", 400);
    }

    if (
      password.length < minimumPasswordLength ||
      password.length > 128 ||
      !/[A-Z]/.test(password) ||
      !/[a-z]/.test(password)
    ) {
      throw createHttpError(
        `Password must be between ${minimumPasswordLength} and 128 characters and include an uppercase and a lowercase letter.`,
        400,
      );
    }

    const passwordHash = await bcrypt.hash(password, passwordSaltRounds);
    const user = {
      name,
      email,
      ...(photoURL ? { photoURL } : {}),
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
    const body = validateRequestBody(req.body, ["email", "password"]);
    const users = req.app.locals.database.collection("users");
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password =
      typeof body.password === "string" ? body.password : "";

    if (
      !emailPattern.test(email) ||
      email.length > 254 ||
      !password ||
      password.length > 128
    ) {
      throw createHttpError("Email or password is incorrect.", 401);
    }

    const user = await users.findOne({ email });
    const passwordMatches = user && typeof user.passwordHash === "string"
      ? await bcrypt.compare(password, user.passwordHash)
      : false;

    if (!passwordMatches) {
      throw createHttpError("Email or password is incorrect.", 401);
    }

    res.json(createAuthResponse(user));
  });

  router.post("/google", async (req, res) => {
    const credential = validateGoogleCredential(req.body);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw createHttpError("Google sign-in is not configured.", 503);
    }

    let payload;
    try {
      const ticket = await new OAuth2Client(clientId).verifyIdToken({
        idToken: credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } catch {
      throw createHttpError("Google sign-in could not verify your account.", 401);
    }

    if (
      !payload ||
      typeof payload.sub !== "string" ||
      typeof payload.email !== "string" ||
      payload.email_verified !== true
    ) {
      throw createHttpError("Google sign-in requires a verified email address.", 401);
    }

    const users = req.app.locals.database.collection("users");
    const googleId = payload.sub;
    const email = payload.email.trim().toLowerCase();
    const googlePhotoURL = getGooglePhotoURL(payload.picture);
    let user = await users.findOne({ googleId });

    if (!user) {
      const existingEmail = await users.findOne({ email });
      if (existingEmail) {
        throw createHttpError(
          "An account with this email already exists. Sign in with email and password.",
          409,
        );
      }

      const name =
        typeof payload.name === "string" && payload.name.trim()
          ? payload.name.trim().slice(0, 80)
          : email.split("@")[0].slice(0, 80);

      user = {
        name,
        email,
        googleId,
        ...(googlePhotoURL ? { photoURL: googlePhotoURL } : {}),
        createdAt: new Date(),
      };

      try {
        const result = await users.insertOne(user);
        user._id = result.insertedId;
      } catch (error) {
        if (error.code !== 11000) {
          throw error;
        }

        user = await users.findOne({ googleId });
        if (!user) {
          throw createHttpError(
            "An account with this email already exists. Sign in with email and password.",
            409,
          );
        }
      }
    }

    if (googlePhotoURL && user.photoURL !== googlePhotoURL) {
      await users.updateOne(
        { _id: user._id },
        { $set: { photoURL: googlePhotoURL } },
      );
      user.photoURL = googlePhotoURL;
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
      { projection: { name: 1, email: 1, photoURL: 1 } },
    );

    if (!user) {
      throw createHttpError("Invalid or expired access token.", 401);
    }

    res.json({
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        ...(typeof user.photoURL === "string"
          ? { photoURL: user.photoURL }
          : {}),
      },
    });
  });

  return router;
}

module.exports = { createAuthRouter };
