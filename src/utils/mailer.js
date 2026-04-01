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

export default {
  sendPasswordResetEmail,
};
