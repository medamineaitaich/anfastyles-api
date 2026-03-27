import logger from '../utils/logger.js';

const errorMiddleware = (err, req, res, next) => {
  const status = err?.statusCode || err?.status || 500;
  const message = err?.message || 'Internal server error';

  logger.error('Request error:', {
    method: req.method,
    url: req.originalUrl,
    status,
    message,
  });

  if (res.headersSent) return next(err);

  res.status(status).json({ error: message });
};

export default errorMiddleware;

