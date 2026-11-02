const express = require("express");
const { ObjectId } = require("mongodb");
const { authenticate } = require("../middleware/authenticate");

const eventTypes = new Set([
  "Cleanup",
  "Plantation",
  "Donation",
  "Community Gathering",
  "Workshop",
  "Other",
]);
const maximumPageSize = 100;
const maximumSkip = 100_000;
const isoDatePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-](\d{2}):(\d{2}))$/;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getAuthenticatedUserId(req) {
  if (!ObjectId.isValid(req.auth.userId)) {
    throw createHttpError("Invalid or expired access token.", 401);
  }

  return new ObjectId(req.auth.userId);
}

function readPositiveInteger(value, defaultValue, maximum, fieldName) {
  if (value === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(value)) {
    throw createHttpError(`${fieldName} must be a positive integer.`, 400);
  }

  const parsedValue = Number(value);
  if (
    !Number.isSafeInteger(parsedValue) ||
    parsedValue < 1 ||
    parsedValue > maximum
  ) {
    throw createHttpError(
      `${fieldName} must be between 1 and ${maximum}.`,
      400,
    );
  }

  return parsedValue;
}

function toPublicEvent(event) {
  return {
    id: event._id.toString(),
    title: event.title,
    description: event.description,
    type: event.type,
    thumbnailUrl: event.thumbnailUrl,
    location: event.location,
    eventDate: event.eventDate.toISOString(),
  };
}

function validateCreateEvent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError("A JSON object is required.", 400);
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const type = typeof body.type === "string" ? body.type : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  const thumbnailUrl =
    typeof body.thumbnailUrl === "string" ? body.thumbnailUrl.trim() : "";
  const eventDateValue =
    typeof body.eventDate === "string" ? body.eventDate : "";
  const dateParts = isoDatePattern.exec(eventDateValue);
  const eventDate = new Date(eventDateValue);

  if (!title || title.length > 120) {
    throw createHttpError(
      "Title is required and must be 120 characters or fewer.",
      400,
    );
  }

  if (!description || description.length > 3000) {
    throw createHttpError(
      "Description is required and must be 3000 characters or fewer.",
      400,
    );
  }

  if (!eventTypes.has(type)) {
    throw createHttpError("Choose a valid event type.", 400);
  }

  if (!location || location.length > 200) {
    throw createHttpError(
      "Location is required and must be 200 characters or fewer.",
      400,
    );
  }

  if (thumbnailUrl.length > 2048) {
    throw createHttpError("Thumbnail URL must be 2048 characters or fewer.", 400);
  }

  let parsedThumbnailUrl;
  try {
    parsedThumbnailUrl = new URL(thumbnailUrl);
  } catch {
    throw createHttpError("A valid thumbnail URL is required.", 400);
  }

  if (!["http:", "https:"].includes(parsedThumbnailUrl.protocol)) {
    throw createHttpError("Thumbnail URL must use HTTP or HTTPS.", 400);
  }

  const year = dateParts ? Number(dateParts[1]) : 0;
  const month = dateParts ? Number(dateParts[2]) : 0;
  const day = dateParts ? Number(dateParts[3]) : 0;
  const hour = dateParts ? Number(dateParts[4]) : 0;
  const minute = dateParts ? Number(dateParts[5]) : 0;
  const second = dateParts?.[6] ? Number(dateParts[6]) : 0;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  const offsetHour = dateParts?.[8] ? Number(dateParts[8]) : 0;
  const offsetMinute = dateParts?.[9] ? Number(dateParts[9]) : 0;

  if (
    !dateParts ||
    !daysInMonth ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    (offsetHour === 14 && offsetMinute !== 0) ||
    offsetMinute > 59 ||
    Number.isNaN(eventDate.getTime())
  ) {
    throw createHttpError(
      "Event date must be an ISO 8601 date with a timezone.",
      400,
    );
  }

  if (eventDate.getTime() <= Date.now()) {
    throw createHttpError("Event date must be in the future.", 400);
  }

  return {
    title,
    description,
    type,
    location,
    thumbnailUrl: parsedThumbnailUrl.toString(),
    eventDate,
  };
}

function createEventsRouter() {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const page = readPositiveInteger(req.query.page, 1, 100_000, "page");
    const limit = readPositiveInteger(
      req.query.limit,
      20,
      maximumPageSize,
      "limit",
    );
    const skip = (page - 1) * limit;

    if (!Number.isSafeInteger(skip) || skip > maximumSkip) {
      throw createHttpError(
        `Requested page is too large; maximum skip is ${maximumSkip}.`,
        400,
      );
    }

    const sortField =
      req.query.sort === undefined ? "eventDate" : req.query.sort;
    if (!["eventDate", "createdAt"].includes(sortField)) {
      throw createHttpError("sort must be eventDate or createdAt.", 400);
    }

    const order = req.query.order === undefined ? "asc" : req.query.order;
    if (!["asc", "desc"].includes(order)) {
      throw createHttpError("order must be asc or desc.", 400);
    }

    const database = req.app.locals.database;
    const filter = { eventDate: { $gt: new Date() } };
    const sortDirection = order === "asc" ? 1 : -1;
    const [documents, total] = await Promise.all([
      database
        .collection("events")
        .find(filter)
        .sort({ [sortField]: sortDirection, _id: sortDirection })
        .skip(skip)
        .limit(limit)
        .toArray(),
      database.collection("events").countDocuments(filter),
    ]);

    res.json({
      events: documents.map(toPublicEvent),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  });

  router.get("/joined", authenticate, async (req, res) => {
    const userId = getAuthenticatedUserId(req);
    const page = readPositiveInteger(req.query.page, 1, 100_000, "page");
    const limit = readPositiveInteger(
      req.query.limit,
      20,
      maximumPageSize,
      "limit",
    );
    const skip = (page - 1) * limit;

    if (!Number.isSafeInteger(skip) || skip > maximumSkip) {
      throw createHttpError(
        `Requested page is too large; maximum skip is ${maximumSkip}.`,
        400,
      );
    }

    const joins = req.app.locals.database.collection("eventJoins");
    const filter = { userId };
    const [documents, total] = await Promise.all([
      joins
        .find(filter)
        .sort({ joinedAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      joins.countDocuments(filter),
    ]);

    res.json({
      events: documents.map((join) => join.event),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  });

  router.get("/:id", async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      throw createHttpError("Event was not found.", 404);
    }

    const event = await req.app.locals.database
      .collection("events")
      .findOne({ _id: new ObjectId(req.params.id) });

    if (!event) {
      throw createHttpError("Event was not found.", 404);
    }

    res.json({ event: toPublicEvent(event) });
  });

  router.post("/", authenticate, async (req, res) => {
    const event = validateCreateEvent(req.body);
    const document = {
      ...event,
      createdBy: getAuthenticatedUserId(req),
      createdAt: new Date(),
    };
    const result = await req.app.locals.database
      .collection("events")
      .insertOne(document);

    res.status(201).json({
      event: toPublicEvent({ ...document, _id: result.insertedId }),
    });
  });

  router.post("/:id/join", authenticate, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      throw createHttpError("Event was not found.", 404);
    }

    const database = req.app.locals.database;
    const event = await database.collection("events").findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!event) {
      throw createHttpError("Event was not found.", 404);
    }

    if (event.eventDate.getTime() <= Date.now()) {
      throw createHttpError("This event has already taken place.", 400);
    }

    const userId = getAuthenticatedUserId(req);
    const user = await database.collection("users").findOne(
      { _id: userId },
      { projection: { _id: 1 } },
    );

    if (!user) {
      throw createHttpError("Invalid or expired access token.", 401);
    }

    const joinedAt = new Date();
    const publicEvent = toPublicEvent(event);

    try {
      await database.collection("eventJoins").insertOne({
        eventId: event._id,
        userId,
        joinedAt,
        event: publicEvent,
      });
    } catch (error) {
      if (error.code === 11000) {
        throw createHttpError("You have already joined this event.", 409);
      }

      throw error;
    }

    res.status(201).json({ event: publicEvent, joinedAt: joinedAt.toISOString() });
  });

  router.put("/:id", authenticate, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      throw createHttpError("Event was not found.", 404);
    }

    const eventId = new ObjectId(req.params.id);
    const createdBy = getAuthenticatedUserId(req);
    const event = validateCreateEvent(req.body);
    const events = req.app.locals.database.collection("events");
    const result = await events.updateOne(
      { _id: eventId, createdBy },
      { $set: event },
    );

    if (result.matchedCount === 0) {
      throw createHttpError("Event was not found.", 404);
    }

    const updatedEvent = await events.findOne({ _id: eventId, createdBy });
    if (!updatedEvent) {
      throw createHttpError("Event was not found.", 404);
    }

    res.json({ event: toPublicEvent(updatedEvent) });
  });

  router.delete("/:id", authenticate, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      throw createHttpError("Event was not found.", 404);
    }

    const result = await req.app.locals.database
      .collection("events")
      .deleteOne({
        _id: new ObjectId(req.params.id),
        createdBy: getAuthenticatedUserId(req),
      });

    if (result.deletedCount === 0) {
      throw createHttpError("Event was not found.", 404);
    }

    res.status(204).end();
  });

  return router;
}

module.exports = { createEventsRouter };
