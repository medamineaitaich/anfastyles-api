import crypto from 'node:crypto';

const passwordResetTokens = new Map();

const DEFAULT_TOKEN_TTL_MINUTES = 60;

const parseTokenTtlMinutes = () => {
  const parsed = Number.parseInt(String(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_TTL_MINUTES;
};

const hashToken = (token) => crypto
  .createHash('sha256')
  .update(String(token || ''))
  .digest('hex');

const purgeExpiredTokens = () => {
  const now = Date.now();

  for (const [tokenHash, tokenData] of passwordResetTokens.entries()) {
    if (!tokenData || tokenData.expiresAt <= now || tokenData.usedAt) {
      passwordResetTokens.delete(tokenHash);
    }
  }
};

export const issuePasswordResetToken = ({ customerId, email }) => {
  purgeExpiredTokens();

  const normalizedCustomerId = Number.parseInt(customerId, 10);
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!Number.isInteger(normalizedCustomerId) || normalizedCustomerId <= 0) {
    throw new Error('A valid customer id is required to issue a reset token');
  }

  if (!normalizedEmail) {
    throw new Error('A valid customer email is required to issue a reset token');
  }

  for (const [tokenHash, tokenData] of passwordResetTokens.entries()) {
    if (tokenData?.customerId === normalizedCustomerId || tokenData?.email === normalizedEmail) {
      passwordResetTokens.delete(tokenHash);
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const ttlMinutes = parseTokenTtlMinutes();
  const expiresAt = Date.now() + (ttlMinutes * 60 * 1000);

  passwordResetTokens.set(tokenHash, {
    customerId: normalizedCustomerId,
    email: normalizedEmail,
    expiresAt,
    createdAt: Date.now(),
    usedAt: null,
  });

  return {
    token,
    expiresAt,
    expiresInMinutes: ttlMinutes,
  };
};

export const consumePasswordResetToken = (token) => {
  purgeExpiredTokens();

  const tokenHash = hashToken(token);
  const tokenData = passwordResetTokens.get(tokenHash);

  if (!tokenData || tokenData.expiresAt <= Date.now() || tokenData.usedAt) {
    passwordResetTokens.delete(tokenHash);
    return null;
  }

  passwordResetTokens.delete(tokenHash);
  return {
    customerId: tokenData.customerId,
    email: tokenData.email,
    expiresAt: tokenData.expiresAt,
    createdAt: tokenData.createdAt,
  };
};

export default {
  issuePasswordResetToken,
  consumePasswordResetToken,
};
