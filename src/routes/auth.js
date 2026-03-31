import express from 'express';
import { createWooCommerceCustomer, getWooCommerceCustomerByEmail, verifyWordPressUser } from '../utils/woocommerce.js';
import { createSession, getSession, deleteSession } from '../utils/sessionManager.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 24 * 60 * 60 * 1000,
};

const normalizeText = (value) => String(value || '').trim();
const normalizeEmail = (value) => normalizeText(value).toLowerCase();

const splitName = (name) => {
  const parts = normalizeText(name).split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
  };
};

const toCheckoutAddress = (source = {}) => ({
  first_name: normalizeText(source.first_name ?? source.firstName),
  last_name: normalizeText(source.last_name ?? source.lastName),
  company: normalizeText(source.company),
  address_1: normalizeText(source.address_1 ?? source.address1 ?? source.address),
  address_2: normalizeText(source.address_2 ?? source.address2),
  city: normalizeText(source.city),
  state: normalizeText(source.state),
  postcode: normalizeText(source.postcode ?? source.zip),
  country: normalizeText(source.country) || 'US',
  email: normalizeEmail(source.email),
  phone: normalizeText(source.phone),
});

const extractCheckoutRegistrationPayload = (body = {}) => {
  const billingSource = body.billing_address || body.billingAddress || body.billing || body.customerInfo || {};
  const shippingSource = body.shipping_address || body.shippingAddress || body.shipping || {};
  const rawName = normalizeText(body.name);
  const billingEmail = normalizeEmail(body.email || billingSource.email);
  const nameParts = splitName(rawName);
  const billingAddress = toCheckoutAddress({
    ...billingSource,
    first_name: billingSource.first_name ?? billingSource.firstName ?? nameParts.firstName,
    last_name: billingSource.last_name ?? billingSource.lastName ?? nameParts.lastName,
    email: billingEmail || billingSource.email,
    phone: body.phone || billingSource.phone,
  });
  const shippingAddress = toCheckoutAddress(
    Object.keys(shippingSource).length > 0 ? shippingSource : billingAddress
  );
  const fullName = `${billingAddress.first_name} ${billingAddress.last_name}`.trim();

  return {
    email: billingEmail,
    password: String(body.password || ''),
    confirmPassword: String(body.confirmPassword || body.confirm_password || ''),
    billingAddress,
    shippingAddress,
    name: fullName || rawName,
    firstName: billingAddress.first_name || nameParts.firstName,
    lastName: billingAddress.last_name || nameParts.lastName,
  };
};

const validatePassword = (password, confirmPassword) => {
  if (!password) return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (confirmPassword !== undefined && password !== confirmPassword) return 'Passwords do not match';
  return null;
};

const createAuthenticatedSession = (res, customer, emailOverride) => {
  const normalizedEmail = normalizeEmail(customer?.email || emailOverride);
  const name = `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim() || normalizedEmail;
  const sessionId = createSession(customer.id, {
    email: normalizedEmail,
    name,
  });

  res.cookie('sessionId', sessionId, COOKIE_OPTIONS);

  return {
    userId: customer.id,
    email: normalizedEmail,
    name,
  };
};

const buildCheckoutRegistrationResponse = (customer, emailOverride) => {
  const normalizedEmail = normalizeEmail(customer?.email || emailOverride);
  const name = `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim() || normalizedEmail;

  return {
    authenticated: true,
    created: true,
    userId: customer.id,
    customerId: customer.id,
    email: normalizedEmail,
    name,
    billing: customer?.billing || {},
    shipping: customer?.shipping || {},
  };
};

const isCustomerCreationConflict = (error) => {
  if (Number(error?.statusCode) === 409) return true;

  const message = String(error?.message || '').toLowerCase();
  return message.includes('already exists')
    || message.includes('already registered')
    || message.includes('please choose another')
    || message.includes('username is already taken');
};

const getCustomerCreationConflictMessage = (error) => {
  if (error?.code === 'username_conflict') {
    return 'We could not create your account because that username is already taken. Please try again.';
  }

  return 'An account already exists for this email';
};

// POST /auth/login - Login with email and password
router.post('/login', async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  logger.info(`Login attempt for email: ${normalizedEmail}`);

  try {
    const customer = await getWooCommerceCustomerByEmail(normalizedEmail);

    if (!customer) {
      logger.warn(`Login failed - customer not found: ${normalizedEmail}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const wpLogin = String(customer?.username || customer?.email || normalizedEmail).trim();
    await verifyWordPressUser(wpLogin, password);

    const sessionUser = createAuthenticatedSession(res, customer, normalizedEmail);

    logger.info(`Login successful for user: ${normalizedEmail}`);

    return res.json(sessionUser);
  } catch (error) {
    if (error?.message === 'Invalid credentials') {
      logger.warn(`Login failed - invalid credentials: ${normalizedEmail}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    return next(error);
  }
});

// POST /auth/register - Register new customer
router.post('/register', async (req, res, next) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  const normalizedEmail = normalizeEmail(email);
  logger.info(`Registration attempt for email: ${normalizedEmail}`);

  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const existingCustomer = await getWooCommerceCustomerByEmail(normalizedEmail);
  if (existingCustomer) {
    logger.warn(`Registration blocked - duplicate email: ${normalizedEmail}`);
    return res.status(409).json({ error: 'An account already exists for this email' });
  }

  const [firstName, ...lastNameParts] = name.split(' ');
  const lastName = lastNameParts.join(' ');

  try {
    const customer = await createWooCommerceCustomer({
      firstName,
      lastName,
      email: normalizedEmail,
      password,
    });

    logger.info(`Customer created: ${normalizedEmail}`);

    const sessionUser = createAuthenticatedSession(res, customer, normalizedEmail);

    return res.json(sessionUser);
  } catch (error) {
    if (isCustomerCreationConflict(error)) {
      logger.warn(`Registration conflict from WooCommerce: ${normalizedEmail}`);
      return res.status(409).json({ error: getCustomerCreationConflictMessage(error) });
    }

    return next(error);
  }
});

// POST /auth/register-checkout - Create a customer account from checkout data
router.post('/register-checkout', async (req, res, next) => {
  const checkoutRegistration = extractCheckoutRegistrationPayload(req.body);
  const {
    email,
    password,
    confirmPassword,
    billingAddress,
    shippingAddress,
    firstName,
    lastName,
  } = checkoutRegistration;

  if (!email) {
    return res.status(400).json({ error: 'Billing email is required' });
  }

  if (!firstName || !lastName) {
    return res.status(400).json({ error: 'Billing first and last name are required' });
  }

  if (!billingAddress.address_1 || !billingAddress.city || !billingAddress.state || !billingAddress.postcode) {
    return res.status(400).json({ error: 'A complete billing address is required' });
  }

  const passwordError = validatePassword(password, confirmPassword);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  logger.info(`Checkout account creation attempt for email: ${email}`);

  try {
    const existingCustomer = await getWooCommerceCustomerByEmail(email);
    if (existingCustomer) {
      logger.warn(`Checkout account creation blocked - duplicate email: ${email}`);
      return res.status(409).json({ error: 'An account already exists for this email' });
    }

    const customer = await createWooCommerceCustomer({
      firstName,
      lastName,
      email,
      password,
      billing: billingAddress,
      shipping: shippingAddress,
    });

    createAuthenticatedSession(res, customer, email);

    logger.info(`Checkout account created: ${email}`);

    return res.json(buildCheckoutRegistrationResponse(customer, email));
  } catch (error) {
    if (isCustomerCreationConflict(error)) {
      logger.warn(`Checkout account creation conflict from WooCommerce: ${email}`);
      return res.status(409).json({ error: getCustomerCreationConflictMessage(error) });
    }

    return next(error);
  }
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
