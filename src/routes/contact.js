import express from 'express';
import logger from '../utils/logger.js';
import { sendContactFormEmail } from '../utils/mailer.js';

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const CONTACT_WINDOW_MS = 15 * 60 * 1000;
const CONTACT_MAX_REQUESTS_PER_WINDOW = 5;
const contactAttemptsByIp = new Map();

const normalizeText = (value) => String(value || '').trim();

const getClientIp = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return normalizeText(req.ip || req.socket?.remoteAddress || 'unknown');
};

const isRateLimited = (ipAddress) => {
  const now = Date.now();
  const attempts = contactAttemptsByIp.get(ipAddress) || [];
  const recentAttempts = attempts.filter((timestamp) => now - timestamp < CONTACT_WINDOW_MS);

  if (recentAttempts.length >= CONTACT_MAX_REQUESTS_PER_WINDOW) {
    contactAttemptsByIp.set(ipAddress, recentAttempts);
    return true;
  }

  recentAttempts.push(now);
  contactAttemptsByIp.set(ipAddress, recentAttempts);
  return false;
};

const validateContactPayload = ({ name, email, message }) => {
  const errors = {};

  if (!normalizeText(name)) {
    errors.name = 'Name is required';
  }

  const normalizedEmail = normalizeText(email).toLowerCase();
  if (!normalizedEmail) {
    errors.email = 'Email is required';
  } else if (!EMAIL_REGEX.test(normalizedEmail)) {
    errors.email = 'A valid email is required';
  }

  if (!normalizeText(message)) {
    errors.message = 'Message is required';
  }

  return errors;
};

const submitContactForm = async (req, res) => {
  const {
    name = '',
    email = '',
    subject = '',
    orderNumber = '',
    message = '',
    website = '',
  } = req.body || {};

  const ipAddress = getClientIp(req);

  if (normalizeText(website)) {
    logger.warn('Blocked contact form honeypot submission', { ipAddress });
    return res.json({
      success: true,
      message: 'Your message has been sent successfully. We will get back to you soon.',
    });
  }

  const errors = validateContactPayload({ name, email, message });
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({
      error: 'Please correct the highlighted fields and try again.',
      errors,
    });
  }

  if (isRateLimited(ipAddress)) {
    logger.warn('Contact form rate limit reached', { ipAddress, email: normalizeText(email).toLowerCase() });
    return res.status(429).json({
      error: 'Too many contact requests. Please wait a few minutes and try again.',
    });
  }

  try {
    await sendContactFormEmail({
      name,
      email,
      subject,
      orderNumber,
      message,
      ipAddress,
    });

    logger.info('Contact form submission delivered', {
      email: normalizeText(email).toLowerCase(),
      ipAddress,
    });

    return res.json({
      success: true,
      message: 'Your message has been sent successfully. We will get back to you soon.',
    });
  } catch (error) {
    logger.error('Failed to process contact form submission', {
      ipAddress,
      email: normalizeText(email).toLowerCase(),
      message: error?.message || String(error),
    });

    return res.status(500).json({
      error: 'Unable to send your message right now. Please try again later.',
    });
  }
};

router.post('/', submitContactForm);
router.post('/submit', submitContactForm);

export default router;
