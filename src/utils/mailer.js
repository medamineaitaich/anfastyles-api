import nodemailer from 'nodemailer';
import logger from './logger.js';

let transport = null;

const normalizeText = (value) => String(value || '').trim();

const isTruthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const createTransport = () => {
  const smtpUrl = normalizeText(process.env.SMTP_URL);
  if (smtpUrl) {
    return nodemailer.createTransport(smtpUrl);
  }

  const host = normalizeText(process.env.SMTP_HOST);
  const port = Number.parseInt(String(process.env.SMTP_PORT || ''), 10);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return null;
  }

  const user = normalizeText(process.env.SMTP_USER);
  const pass = normalizeText(process.env.SMTP_PASS);

  return nodemailer.createTransport({
    host,
    port,
    secure: isTruthy(process.env.SMTP_SECURE) || port === 465,
    auth: user ? { user, pass } : undefined,
  });
};

const getTransport = () => {
  if (transport !== null) return transport;
  transport = createTransport();
  return transport;
};

const getResolvedFromConfig = () => {
  const fromEmail = normalizeText(process.env.CONTACT_FROM_EMAIL || process.env.SMTP_FROM_EMAIL || process.env.MAIL_FROM_EMAIL);
  const fromName = normalizeText(process.env.CONTACT_FROM_NAME || process.env.SMTP_FROM_NAME || process.env.MAIL_FROM_NAME || 'AnfaStyles');

  return {
    fromEmail,
    fromName,
  };
};

export const sendPasswordResetEmail = async ({
  to,
  name,
  resetUrl,
  expiresInMinutes,
}) => {
  const recipient = normalizeText(to).toLowerCase();
  const fromEmail = normalizeText(process.env.SMTP_FROM_EMAIL || process.env.MAIL_FROM_EMAIL);
  const fromName = normalizeText(process.env.SMTP_FROM_NAME || process.env.MAIL_FROM_NAME || 'AnfaStyles');
  const resolvedTransport = getTransport();

  if ((!resolvedTransport || !fromEmail) && process.env.NODE_ENV !== 'production') {
    logger.info(`Password reset email fallback for ${recipient}: ${resetUrl}`);
    return {
      accepted: [recipient],
      messageId: 'dev-password-reset-fallback',
      previewUrl: resetUrl,
    };
  }

  if (!resolvedTransport || !fromEmail) {
    throw new Error('Password reset email is not configured');
  }

  const displayName = normalizeText(name) || 'there';
  const appName = normalizeText(process.env.APP_NAME || 'AnfaStyles');
  const expiryText = expiresInMinutes === 1 ? '1 minute' : `${expiresInMinutes} minutes`;

  const text = [
    `Hello ${displayName},`,
    '',
    `We received a request to reset your ${appName} password.`,
    `Use the link below to set a new password. This link expires in ${expiryText}.`,
    '',
    resetUrl,
    '',
    'If you did not request a password reset, you can safely ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
      <p>Hello ${displayName},</p>
      <p>We received a request to reset your ${appName} password.</p>
      <p>Use the button below to set a new password. This link expires in <strong>${expiryText}</strong>.</p>
      <p style="margin: 24px 0;">
        <a href="${resetUrl}" style="display: inline-block; padding: 12px 20px; background: #2f5725; color: #ffffff; text-decoration: none; border-radius: 6px;">
          Reset your password
        </a>
      </p>
      <p>If the button does not work, copy and paste this link into your browser:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you did not request a password reset, you can safely ignore this email.</p>
    </div>
  `;

  const info = await resolvedTransport.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to: recipient,
    subject: `${appName} password reset`,
    text,
    html,
  });

  logger.info(`Password reset email sent to ${recipient}`, info?.messageId ? `messageId=${info.messageId}` : '');
  return info;
};

export const sendContactFormEmail = async ({
  name,
  email,
  subject,
  message,
  orderNumber,
  ipAddress,
}) => {
  const recipient = normalizeText(process.env.CONTACT_TO_EMAIL || process.env.MAIL_TO_EMAIL);
  const resolvedTransport = getTransport();
  const { fromEmail, fromName } = getResolvedFromConfig();
  const senderName = normalizeText(name) || 'Website visitor';
  const senderEmail = normalizeText(email).toLowerCase();
  const cleanedSubject = normalizeText(subject) || 'Website contact form submission';
  const cleanedMessage = normalizeText(message);
  const cleanedOrderNumber = normalizeText(orderNumber);
  const cleanedIp = normalizeText(ipAddress);

  if ((!resolvedTransport || !fromEmail || !recipient) && process.env.NODE_ENV !== 'production') {
    logger.info('Contact email fallback', {
      to: recipient || null,
      from: fromEmail || null,
      senderName,
      senderEmail,
      subject: cleanedSubject,
      orderNumber: cleanedOrderNumber || null,
      ipAddress: cleanedIp || null,
      message: cleanedMessage,
    });

    return {
      accepted: recipient ? [recipient] : [],
      messageId: 'dev-contact-email-fallback',
    };
  }

  if (!resolvedTransport || !fromEmail || !recipient) {
    throw new Error('Contact email is not configured');
  }

  const subjectLine = `[Contact] ${cleanedSubject}`;
  const text = [
    'New contact form submission',
    '',
    `Name: ${senderName}`,
    `Email: ${senderEmail}`,
    `Subject: ${cleanedSubject}`,
    `Order number: ${cleanedOrderNumber || 'N/A'}`,
    `IP address: ${cleanedIp || 'N/A'}`,
    '',
    'Message:',
    cleanedMessage,
  ].join('\n');

  const html = `
    <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.6;">
      <h2 style="margin-bottom: 16px;">New contact form submission</h2>
      <p><strong>Name:</strong> ${senderName}</p>
      <p><strong>Email:</strong> <a href="mailto:${senderEmail}">${senderEmail}</a></p>
      <p><strong>Subject:</strong> ${cleanedSubject}</p>
      <p><strong>Order number:</strong> ${cleanedOrderNumber || 'N/A'}</p>
      <p><strong>IP address:</strong> ${cleanedIp || 'N/A'}</p>
      <div style="margin-top: 20px;">
        <p><strong>Message:</strong></p>
        <p style="white-space: pre-wrap;">${cleanedMessage}</p>
      </div>
    </div>
  `;

  const info = await resolvedTransport.sendMail({
    from: `${fromName} <${fromEmail}>`,
    to: recipient,
    replyTo: senderEmail,
    subject: subjectLine,
    text,
    html,
  });

  logger.info(`Contact form email sent from ${senderEmail}`, info?.messageId ? `messageId=${info.messageId}` : '');
  return info;
};

export default {
  sendPasswordResetEmail,
  sendContactFormEmail,
};
