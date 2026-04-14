import express from 'express';
import axios from 'axios';
import logger from '../utils/logger.js';

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const CONTACT_WINDOW_MS = 15 * 60 * 1000;
const CONTACT_MAX_REQUESTS_PER_WINDOW = 5;
const contactAttemptsByIp = new Map();

const normalizeText = (value) => String(value || '').trim();
const normalizeEmail = (value) => normalizeText(value).toLowerCase();

const getWordPressContactUrl = () => {
  const storeUrl = normalizeText(process.env.WC_STORE_URL || 'https://wp.anfastyles.shop');
  const base = storeUrl ? storeUrl.replace(/\/+$/, '') : 'https://wp.anfastyles.shop';
  return `${base}/wp-json/anfa/v1/contact`;
};

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

  const normalizedEmail = normalizeEmail(email);
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
    const normalizedName = normalizeText(name);
    const normalizedSubject = normalizeText(subject);
    const normalizedMessage = normalizeText(message);
    const normalizedOrder = normalizeText(orderNumber);
    const forwardedMessage = normalizedOrder
      ? `${normalizedMessage}\n\nOrder number: ${normalizedOrder}`
      : normalizedMessage;

    const response = await axios.post(
      getWordPressContactUrl(),
      {
        name: normalizedName,
        email: normalizeEmail(email),
        subject: normalizedSubject,
        message: forwardedMessage,
      },
      {
        timeout: 20000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    logger.info('Contact form submission delivered', {
      email: normalizeEmail(email),
      ipAddress,
    });

    return res.json({
      success: true,
      message: response?.data?.message
        || 'Your message has been sent successfully. We will get back to you soon.',
    });
  } catch (error) {
    const status = error?.response?.status || 500;
    logger.error('Failed to process contact form submission', {
      ipAddress,
      email: normalizeEmail(email),
      status,
      message: error?.response?.data?.message || error?.message || String(error),
    });

    if (status >= 400 && status < 500) {
      return res.status(status).json({
        error: error?.response?.data?.message || 'Unable to send your message right now.',
      });
    }

    return res.status(502).json({
      error: 'Unable to send your message right now. Please try again later.',
    });
  }
};

router.post('/', submitContactForm);
router.post('/submit', submitContactForm);

export default router;
