import { getSession } from '../utils/sessionManager.js';
import logger from '../utils/logger.js';

export const requireAuth = (req, res, next) => {
  const sessionId = req.cookies?.sessionId;

  if (!sessionId) {
    logger.warn('Unauthorized access attempt - no session');
    return res.status(401).json({ error: 'Unauthorized - no session' });
  }

  const session = getSession(sessionId);
  if (!session) {
    logger.warn('Unauthorized access attempt - invalid session');
    return res.status(401).json({ error: 'Unauthorized - invalid session' });
  }

  req.session = session;
  next();
};

export default requireAuth;
