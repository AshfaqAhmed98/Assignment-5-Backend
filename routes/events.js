const Busboy = require("busboy");
const express = require("express");
const { GridFSBucket, ObjectId } = require("mongodb");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { authenticate } = require("../middleware/authenticate");

const eventTypes = new Set([
  "Cleanup",
  "Plantation",
  "Donation",
  "Community Gathering",
  "Workshop",
  "Other",
]);
const eventFields = new Set([
  "title",
  "description",
  "type",
  "thumbnailUrl",
  "location",
  "eventDate",
]);
const eventListQueryFields = new Set(["page", "limit", "sort", "order"]);
const joinedEventsQueryFields = new Set(["page", "limit"]);
const managedEventsQueryFields = new Set(["page", "limit"]);
const maximumPageSize = 100;
const maximumSkip = 100_000;
const maximumThumbnailSize = 50 * 1024 * 1024;
const thumbnailBucketName = "eventImages";
const idempotencyKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

  if (typeof value !== "string" || !/^\d+$/.test(value)) {
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

function validateQueryParameters(query, allowedFields) {
  const unexpectedField = Object.keys(query).find(
    (field) => !allowedFields.has(field),
  );
  if (unexpectedField) {
    throw createHttpError(
      "Request contains an unsupported query parameter.",
      400,
    );
  }
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

function validateCreateEvent(body, { allowMissingThumbnail = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw createHttpError("A JSON object is required.", 400);
  }

  const unexpectedField = Object.keys(body).find(
    (field) => !eventFields.has(field),
  );
  if (unexpectedField) {
    throw createHttpError("Request contains an unsupported field.", 400);
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description =
    typeof body.description === "string" ? body.description.trim() : "";
  const type = typeof body.type === "string" ? body.type : "";
  const location = typeof body.location === "string" ? body.location.trim() : "";
  let thumbnailUrl =
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

  if (!thumbnailUrl && allowMissingThumbnail) {
    thumbnailUrl = null;
  } else if (thumbnailUrl.length > 2048) {
    throw createHttpError("Thumbnail URL must be 2048 characters or fewer.", 400);
  }

  if (thumbnailUrl) {
    const isStoredImage = /^\/backend\/api\/events\/images\/[0-9a-f]{24}$/i.test(
      thumbnailUrl,
    );
    if (!isStoredImage) {
      let parsedThumbnailUrl;
      try {
        parsedThumbnailUrl = new URL(thumbnailUrl);
      } catch {
        throw createHttpError("A valid thumbnail URL is required.", 400);
      }

      if (!["http:", "https:"].includes(parsedThumbnailUrl.protocol)) {
        throw createHttpError("Thumbnail URL must use HTTP or HTTPS.", 400);
      }

      thumbnailUrl = parsedThumbnailUrl.toString();
    }
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
    thumbnailUrl,
    eventDate,
  };
}

function createImageSignatureValidator(contentType) {
  let header = Buffer.alloc(0);

  return new Transform({
    transform(chunk, _encoding, callback) {
      if (header.length >= 8) {
        callback(null, chunk);
        return;
      }

      const bytesNeeded = 8 - header.length;
      const prefix = chunk.subarray(0, bytesNeeded);
      header = Buffer.concat([header, prefix]);
      if (header.length < 8) {
        callback();
        return;
      }

      const isJpeg =
        contentType === "image/jpeg" &&
        header[0] === 0xff &&
        header[1] === 0xd8 &&
        header[2] === 0xff;
      const isPng =
        contentType === "image/png" &&
        header.equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        );

      if (!isJpeg && !isPng) {
        callback(createHttpError("Thumbnail must be a valid JPG or PNG image.", 400));
        return;
      }

      callback(null, Buffer.concat([header, chunk.subarray(bytesNeeded)]));
    },
    flush(callback) {
      if (header.length < 8) {
        callback(createHttpError("Thumbnail image is incomplete.", 400));
        return;
      }

      callback();
    },
  });
}

function parseEventMultipart(req, database) {
  return new Promise((resolve, reject) => {
    const bucket = new GridFSBucket(database, { bucketName: thumbnailBucketName });
    const fields = {};
    let fileId = null;
    let contentType = null;
    let uploadStream = null;
    let uploadFinished = Promise.resolve();
    let uploadCompleted = false;
    let uploadAborted = false;
    let failure = null;

    function fail(error) {
      failure ??= error;
    }

    function abortUpload() {
      if (uploadStream && !uploadCompleted && !uploadAborted) {
        uploadAborted = true;
        uploadStream.abort();
      }
    }

    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          fileSize: maximumThumbnailSize,
          files: 1,
          fields: 10,
          parts: 11,
          fieldSize: 4096,
        },
      });
    } catch {
      reject(createHttpError("A valid multipart event form is required.", 400));
      return;
    }

    parser.on("field", (name, value, info) => {
      if (info.valueTruncated || Object.hasOwn(fields, name)) {
        fail(createHttpError("Event form contains an invalid or repeated field.", 400));
        return;
      }

      fields[name] = value;
    });

    parser.on("file", (fieldName, file, info) => {
      if (fieldName !== "thumbnail" || fileId) {
        fail(createHttpError("Only one thumbnail image can be uploaded.", 400));
        file.resume();
        return;
      }

      if (!["image/jpeg", "image/png"].includes(info.mimeType)) {
        fail(createHttpError("Thumbnail must be a JPG or PNG image.", 400));
        file.resume();
        return;
      }

      fileId = new ObjectId();
      contentType = info.mimeType;
      uploadStream = bucket.openUploadStream("thumbnail", {
        id: fileId,
        metadata: { contentType },
      });

      const signatureValidator = createImageSignatureValidator(contentType);
      uploadFinished = new Promise((resolveUpload, rejectUpload) => {
        uploadStream.once("finish", () => {
          uploadCompleted = true;
          resolveUpload();
        });
        uploadStream.once("error", rejectUpload);
        signatureValidator.once("error", (error) => {
          fail(error);
          rejectUpload(error);
          file.unpipe(signatureValidator);
          file.resume();
          abortUpload();
        });
        file.once("error", rejectUpload);
        file.once("limit", () => {
          fail(createHttpError("Thumbnail images must be 50 MB or smaller.", 413));
        });
      });
      void uploadFinished.catch(() => {});
      file.pipe(signatureValidator).pipe(uploadStream);
    });

    parser.on("fieldsLimit", () => {
      fail(createHttpError("Event form contains too many fields.", 400));
    });
    parser.on("filesLimit", () => {
      fail(createHttpError("Only one thumbnail image can be uploaded.", 400));
    });
    parser.on("partsLimit", () => {
      fail(createHttpError("Event form contains too many parts.", 400));
    });
    parser.on("error", fail);
    parser.on("close", async () => {
      try {
        await uploadFinished;
      } catch (error) {
        fail(error);
      }

      if (failure) {
        if (fileId && uploadCompleted) {
          try {
            await bucket.delete(fileId);
          } catch (cleanupError) {
            console.error("Unable to clean up an invalid thumbnail upload:", cleanupError);
          }
        } else if (uploadStream && !uploadCompleted) {
          abortUpload();
        }
        reject(failure);
        return;
      }

      resolve({ fields, fileId, contentType });
    });

    req.pipe(parser);
  });
}

async function deleteUploadedThumbnail(database, fileId) {
  try {
    await new GridFSBucket(database, { bucketName: thumbnailBucketName }).delete(
      fileId,
    );
  } catch (error) {
    console.error("Unable to clean up an unused thumbnail upload:", error);
  }
}

function createEventsRouter() {
  const router = express.Router();

  router.get("/", async (req, res) => {
    validateQueryParameters(req.query, eventListQueryFields);
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
    validateQueryParameters(req.query, joinedEventsQueryFields);
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
        .sort({ "event.eventDate": 1, _id: 1 })
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

  router.get("/mine", authenticate, async (req, res) => {
    validateQueryParameters(req.query, managedEventsQueryFields);
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

    const events = req.app.locals.database.collection("events");
    const filter = { createdBy: userId };
    const [documents, total] = await Promise.all([
      events
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      events.countDocuments(filter),
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

  router.get("/:id/join", authenticate, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      throw createHttpError("Event was not found.", 404);
    }

    const database = req.app.locals.database;
    const eventId = new ObjectId(req.params.id);
    const userId = getAuthenticatedUserId(req);
    const event = await database
      .collection("events")
      .findOne({ _id: eventId }, { projection: { _id: 1, createdBy: 1 } });

    if (!event) {
      throw createHttpError("Event was not found.", 404);
    }

    const isOwner =
      event.createdBy instanceof ObjectId && event.createdBy.equals(userId);
    if (isOwner) {
      await database.collection("eventJoins").deleteOne({ eventId, userId });
      res.json({ joined: false, isOwner: true });
      return;
    }

    const join = await database.collection("eventJoins").findOne(
      { eventId, userId },
      { projection: { _id: 1 } },
    );
    res.json({ joined: Boolean(join), isOwner: false });
  });

  router.post("/", authenticate, async (req, res) => {
    const idempotencyKey = req.get("Idempotency-Key");
    if (idempotencyKey !== undefined && !idempotencyKeyPattern.test(idempotencyKey)) {
      throw createHttpError("Idempotency-Key must be a UUID.", 400);
    }

    const database = req.app.locals.database;
    const createdBy = getAuthenticatedUserId(req);
    const creator = await database
      .collection("users")
      .findOne({ _id: createdBy }, { projection: { email: 1 } });
    if (!creator || typeof creator.email !== "string") {
      throw createHttpError("Your account could not be found.", 401);
    }
    const upload = req.is("multipart/form-data")
      ? await parseEventMultipart(req, database)
      : { fields: req.body, fileId: null };

    try {
      const event = validateCreateEvent(upload.fields, {
        allowMissingThumbnail: Boolean(upload.fileId),
      });
      if (upload.fileId) {
        event.thumbnailUrl = `/backend/api/events/images/${upload.fileId.toString()}`;
      }

      const document = {
        ...event,
        createdBy,
        createdByEmail: creator.email,
        createdAt: new Date(),
        ...(idempotencyKey ? { creationRequestId: idempotencyKey } : {}),
      };
      const events = database.collection("events");
      let result;
      try {
        result = await events.insertOne(document);
      } catch (error) {
        if (idempotencyKey && error.code === 11000) {
          const previousEvent = await events.findOne({
            createdBy,
            creationRequestId: idempotencyKey,
          });
          if (previousEvent) {
            if (upload.fileId) {
              await deleteUploadedThumbnail(database, upload.fileId);
            }
            res.status(201).json({ event: toPublicEvent(previousEvent) });
            return;
          }
        }
        throw error;
      }

      res.status(201).json({
        event: toPublicEvent({ ...document, _id: result.insertedId }),
      });
    } catch (error) {
      if (upload.fileId) {
        await deleteUploadedThumbnail(database, upload.fileId);
      }
      throw error;
    }
  });

  router.get("/images/:id", async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      throw createHttpError("Thumbnail image was not found.", 404);
    }

    const bucket = new GridFSBucket(req.app.locals.database, {
      bucketName: thumbnailBucketName,
    });
    const file = await bucket
      .find({ _id: new ObjectId(req.params.id) })
      .next();
    if (!file || !["image/jpeg", "image/png"].includes(file.metadata?.contentType)) {
      throw createHttpError("Thumbnail image was not found.", 404);
    }

    res.set({
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Length": String(file.length),
      "Content-Type": file.metadata.contentType,
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(bucket.openDownloadStream(file._id), res);
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
    if (
      event.createdBy instanceof ObjectId &&
      event.createdBy.equals(userId)
    ) {
      throw createHttpError(
        "You created this event. Hosts are not listed as attendees.",
        403,
      );
    }

    const user = await database.collection("users").findOne(
      { _id: userId },
      { projection: { _id: 1 } },
    );

    if (!user) {
      throw createHttpError("Invalid or expired access token.", 401);
    }

    const joinedAt = new Date();
    const publicEvent = toPublicEvent(event);
    const joins = database.collection("eventJoins");

    try {
      await joins.insertOne({
        eventId: event._id,
        userId,
        joinedAt,
        event: publicEvent,
      });
    } catch (error) {
      if (error.code === 11000) {
        const existingJoin = await joins.findOne(
          { eventId: event._id, userId },
          { projection: { joinedAt: 1 } },
        );
        if (existingJoin) {
          res.json({
            event: publicEvent,
            joinedAt: existingJoin.joinedAt.toISOString(),
          });
          return;
        }
      }

      throw error;
    }

    res.status(201).json({ event: publicEvent, joinedAt: joinedAt.toISOString() });
  });

  router.delete("/:id/join", authenticate, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      throw createHttpError("Event was not found.", 404);
    }

    await req.app.locals.database.collection("eventJoins").deleteOne({
      eventId: new ObjectId(req.params.id),
      userId: getAuthenticatedUserId(req),
    });

    res.status(204).end();
  });

  router.put("/:id", authenticate, async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) {
      throw createHttpError("Event was not found.", 404);
    }

    const eventId = new ObjectId(req.params.id);
    const createdBy = getAuthenticatedUserId(req);
    const database = req.app.locals.database;
    const events = database.collection("events");
    const currentEvent = await events.findOne(
      { _id: eventId, createdBy },
      { projection: { _id: 1 } },
    );
    if (!currentEvent) {
      throw createHttpError("Event was not found.", 404);
    }

    const upload = req.is("multipart/form-data")
      ? await parseEventMultipart(req, database)
      : { fields: req.body, fileId: null };
    let updateApplied = false;
    try {
      const event = validateCreateEvent(upload.fields, {
        allowMissingThumbnail: Boolean(upload.fileId),
      });
      if (upload.fileId) {
        event.thumbnailUrl = `/backend/api/events/images/${upload.fileId.toString()}`;
      }

      const result = await events.updateOne(
        { _id: eventId, createdBy },
        { $set: event },
      );
      if (result.matchedCount === 0) {
        throw createHttpError("Event was not found.", 404);
      }
      updateApplied = true;

      const updatedEvent = await events.findOne({ _id: eventId, createdBy });
      if (!updatedEvent) {
        throw createHttpError("Event was not found.", 404);
      }

      res.json({ event: toPublicEvent(updatedEvent) });
    } catch (error) {
      if (upload.fileId && !updateApplied) {
        await deleteUploadedThumbnail(database, upload.fileId);
      }
      throw error;
    }
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
