function notFoundHandler(req, _res, next) {
  const error = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
}

function errorHandler(error, _req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  const isInvalidJson = error.type === "entity.parse.failed";
  const isPayloadTooLarge = error.type === "entity.too.large";
  const requestedStatus = error.statusCode ?? error.status;
  const statusCode =
    isInvalidJson
      ? 400
      : isPayloadTooLarge
        ? 413
        : Number.isInteger(requestedStatus) &&
            requestedStatus >= 400 &&
            requestedStatus <= 599
          ? requestedStatus
          : 500;

  if (statusCode >= 500) {
    console.error("Request failed:", error);
  }

  const message =
    isInvalidJson
      ? "Request body must contain valid JSON."
      : isPayloadTooLarge
        ? "Request body exceeds the allowed size."
        : statusCode >= 500
          ? statusCode === 503
            ? "Service unavailable."
            : "Internal server error."
          : error.message;

  res.status(statusCode).json({
    error: { message },
  });
}

module.exports = { errorHandler, notFoundHandler };
