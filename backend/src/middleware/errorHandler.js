// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // err may be a plain object { status, message } passed via next(), or a real Error.
  if (err.stack) console.error(err.stack);
  const status = err.status || 500;
  // Expose the message only; never forward internal error details to the client.
  res.status(status).json({
    error: err.message || err.msg || 'Internal server error',
  });
}

module.exports = errorHandler;
