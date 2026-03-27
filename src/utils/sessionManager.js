import 'dotenv/config';

const sessions = new Map();

const generateSessionId = () => {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
};

export const createSession = (userId, userData) => {
  const sessionId = generateSessionId();
  const sessionData = {
    userId,
    email: userData.email,
    name: userData.name,
    createdAt: Date.now(),
    expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
  };
  sessions.set(sessionId, sessionData);
  return sessionId;
};

export const getSession = (sessionId) => {
  const session = sessions.get(sessionId);
  if (!session) return null;

  // Check if session has expired
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
};

export const deleteSession = (sessionId) => {
  sessions.delete(sessionId);
};

export const verifySession = (sessionId) => {
  return getSession(sessionId) !== null;
};

export default {
  createSession,
  getSession,
  deleteSession,
  verifySession,
};
