// src/middleware/errorHandler.js
// Global error catching to prevent server crashes and format responses

export function errorHandler(err, req, res, next) {
  // Log the error in the backend console for debugging
  console.error(`❌ [Error] ${req.method} ${req.originalUrl} ->`, err.message);

  // Determine the status code (default to 500 Internal Server Error)
  const statusCode = err.status || err.statusCode || 500;

  // Send a clean JSON response to the frontend
  res.status(statusCode).json({
    success: false,
    error: err.message || 'Internal Server Error',
    // Optionally include stack traces only in development mode
    stack: process.env.NODE_ENV === 'production' ? null : err.stack
  });
}