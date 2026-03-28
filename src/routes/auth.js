import express from 'express';
import { createWooCommerceCustomer, getWooCommerceCustomerByEmail, verifyWordPressUser } from '../utils/woocommerce.js';
import { createSession, getSession, deleteSession } from '../utils/sessionManager.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

// POST /auth/login - Login with email and password
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  logger.info(`Login attempt for email: ${email}`);

  try {
    const usernameFromEmail = String(email).split('@')[0];

    const customer = await getWooCommerceCustomerByEmail(email);
    if (!customer?.id) {
      logger.warn(`Login failed - user not found: ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Verify password against WordPress login form (no JWT plugin required).
    // WordPress typically accepts either username or email in the login field,
    // but we fall back to the stored username for compatibility.
    try {
      await verifyWordPressUser(email, password);
    } catch (e) {
      const username = customer.username || usernameFromEmail;
      if (!username) throw e;
      await verifyWordPressUser(username, password);
    }

    const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || customer.username || email;
    const sessionId = createSession(customer.id, {
      email: customer.email || email,
      name,
    });

    res.cookie('sessionId', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    logger.info(`Login successful for user: ${email}`);

    return res.json({
      userId: customer.id,
      email: customer.email || email,
      name,
    });
  } catch (error) {
    const msg = String(error?.message || '');
    if (msg.toLowerCase().includes('invalid credentials')) {
      logger.warn(`Login failed - invalid credentials: ${email}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    logger.error('Login error:', error?.message || error);
    return res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/register - Register new customer
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  logger.info(`Registration attempt for email: ${email}`);

  // Create WooCommerce customer
  const [firstName, ...lastNameParts] = name.split(' ');
  const lastName = lastNameParts.join(' ');

  const customer = await createWooCommerceCustomer({
    firstName,
    lastName,
    email,
    password,
  });

  logger.info(`Customer created: ${email}`);

  // Auto-login
  const sessionId = createSession(customer.id, {
    email: customer.email,
    name: customer.first_name + ' ' + customer.last_name,
  });

  res.cookie('sessionId', sessionId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({
    userId: customer.id,
    email: customer.email,
    name: customer.first_name + ' ' + customer.last_name,
  });
});

// POST /auth/logout - Logout and clear session
router.post('/logout', requireAuth, (req, res) => {
  const sessionId = req.cookies?.sessionId;

  if (sessionId) {
    deleteSession(sessionId);
    logger.info(`Logout successful for user: ${req.session.email}`);
  }

  res.clearCookie('sessionId');
  res.json({ message: 'Logged out successfully' });
});

// GET /auth/verify - Verify session validity
router.get('/verify', (req, res) => {
  const sessionId = req.cookies?.sessionId;

  if (!sessionId) {
    return res.json({ authenticated: false });
  }

  const session = getSession(sessionId);

  if (!session) {
    return res.json({ authenticated: false });
  }

  logger.info(`Session verified for user: ${session.email}`);

  res.json({
    authenticated: true,
    userId: session.userId,
    email: session.email,
    name: session.name,
  });
});

export default router;
