import express from 'express';
import logger from '../utils/logger.js';

const router = express.Router();

const contactSubmissions = [];

// POST /contact/submit - Submit contact form
router.post('/submit', (req, res) => {
  const { name, email, subject, orderNumber, message } = req.body;

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'Name, email, subject, and message are required' });
  }

  logger.info(`Contact form submitted by: ${email}`);

  const submission = {
    id: Date.now(),
    name,
    email,
    subject,
    orderNumber: orderNumber || null,
    message,
    submittedAt: new Date().toISOString(),
  };

  contactSubmissions.push(submission);

  // In production, you would send an email here using PocketBase hooks
  // For now, we're storing the submission
  logger.info(`Contact submission stored: ${submission.id}`);

  res.json({
    success: true,
    message: 'Your message has been received. We will get back to you soon.',
    submissionId: submission.id,
  });
});

export default router;
