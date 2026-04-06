import express from 'express';
import axios from 'axios';
import logger from '../utils/logger.js';
import { getStripeClient } from '../utils/stripe.js';

const router = express.Router();

const toNumber = (value) => {
  const n = typeof value === 'string' && value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(n) ? n : NaN;
};

const toAmountMinor = (value) => {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
};

const computeCartItemsMinor = (cartItems = []) => {
  if (!Array.isArray(cartItems)) return NaN;
  let sum = 0;

  for (const item of cartItems) {
    const quantity = Math.max(0, Math.trunc(toNumber(item?.quantity)));
    const price = toNumber(item?.price);
    if (!Number.isFinite(price)) return NaN;
    sum += Math.round(price * 100) * quantity;
  }

  return sum;
};

let cachedStripePublishableKey = null;
let cachedStripePublishableKeyAtMs = 0;
let cachedWooPaymentsConfig = null;
let cachedWooPaymentsConfigAtMs = 0;

const getStoreBaseUrl = () => {
  const storeUrl = process.env.WC_STORE_URL ? String(process.env.WC_STORE_URL).trim() : '';
  return storeUrl ? storeUrl.replace(/\/+$/, '') : '';
};

const scrapeStripePublishableKey = async () => {
  const storeUrl = getStoreBaseUrl();
  if (!storeUrl) return null;

  const now = Date.now();
  if (cachedStripePublishableKey && now - cachedStripePublishableKeyAtMs < 60 * 60 * 1000) {
    return cachedStripePublishableKey;
  }

  // Scrape the WP checkout page to find the Stripe gateway publishable key (test or live).
  // This keeps headless Stripe.js aligned with the WooCommerce Stripe gateway configuration.
  const checkoutUrl = `${storeUrl}/checkout/`;
  const response = await axios.get(checkoutUrl, { timeout: 20000 });
  const html = String(response?.data || '');

  const match = html.match(/\"stripe\"\s*:\s*\{[^}]*\"publishable_key\"\s*:\s*\"(pk_(?:test|live)_[A-Za-z0-9]+)\"/i);
  const key = match?.[1] ? String(match[1]).trim() : '';
  if (!key) return null;

  cachedStripePublishableKey = key;
  cachedStripePublishableKeyAtMs = now;
  return key;
};

const getStripePublishableKey = async () => {
  const direct = process.env.STRIPE_PUBLISHABLE_KEY ? String(process.env.STRIPE_PUBLISHABLE_KEY).trim() : '';
  const scraped = await scrapeStripePublishableKey().catch((error) => {
    logger.warn('Failed to scrape WooCommerce Stripe publishable key, falling back to env if available', {
      message: error?.message || String(error),
    });
    return null;
  });

  if (scraped) {
    if (direct && direct !== scraped) {
      logger.warn('STRIPE_PUBLISHABLE_KEY does not match the WooCommerce Stripe gateway publishable key; using the WooCommerce key', {
        configuredKeyPrefix: direct.slice(0, 12),
        wooKeyPrefix: scraped.slice(0, 12),
      });
    }

    return scraped;
  }

  return direct || null;
};

const getWooPaymentsConfig = async () => {
  const storeUrl = getStoreBaseUrl();
  if (!storeUrl) return null;

  const now = Date.now();
  if (cachedWooPaymentsConfig && now - cachedWooPaymentsConfigAtMs < 5 * 60 * 1000) {
    return cachedWooPaymentsConfig;
  }

  const response = await axios.get(`${storeUrl}/wp-json/anfastyles/v1/woopayments-config`, {
    timeout: 20000,
  });

  const data = response?.data;
  if (!data || typeof data !== 'object') return null;

  cachedWooPaymentsConfig = data;
  cachedWooPaymentsConfigAtMs = now;
  return data;
};

// GET /payments/stripe/publishable-key
// Returns the Stripe publishable key used by the WooCommerce Stripe gateway (test/live).
router.get('/stripe/publishable-key', async (req, res) => {
  try {
    const publishableKey = await getStripePublishableKey();
    if (!publishableKey) {
      return res.status(503).json({
        error: 'Stripe publishable key is not available',
        requiredEnvVars: ['WC_STORE_URL'],
        optionalEnvVars: ['STRIPE_PUBLISHABLE_KEY'],
      });
    }

    return res.json({ publishableKey });
  } catch (error) {
    logger.error('Failed to load Stripe publishable key:', { message: error?.message || String(error) });
    return res.status(500).json({ error: 'Failed to load Stripe publishable key' });
  }
});

// GET /payments/woopayments/config
// Proxies the WooPayments headless config from WordPress so the frontend can stay on the API layer.
router.get('/woopayments/config', async (req, res) => {
  try {
    const configData = await getWooPaymentsConfig();
    if (!configData?.ok || !configData?.isReady || !configData?.config?.publishableKey) {
      return res.status(503).json({
        error: 'WooPayments config is not available',
        details: configData || null,
        requiredEnvVars: ['WC_STORE_URL'],
      });
    }

    return res.json(configData);
  } catch (error) {
    const status = error?.response?.status || error?.status || 500;
    const details = error?.response?.data || null;

    logger.error('Failed to load WooPayments config:', {
      status,
      message: error?.message || String(error),
    });

    if (status >= 400 && status < 500) {
      return res.status(status).json({
        error: 'Failed to load WooPayments config',
        details,
      });
    }

    return res.status(500).json({
      error: 'Failed to load WooPayments config',
      details,
    });
  }
});

// POST /payments/woopayments/intent
// Minimal PaymentIntent creation for the headless checkout card flow.
router.post('/woopayments/intent', async (req, res) => {
  try {
    const stripe = getStripeClient();
    if (!stripe) {
      return res.status(503).json({
        error: 'Stripe is not configured',
        requiredEnvVars: ['STRIPE_SECRET_KEY'],
      });
    }

    const {
      cartItems,
      shippingCost,
      tax,
      total,
      amountMinor,
      currency,
      orderId,
      customerEmail,
    } = req.body || {};

    const currencyCode = String(currency || process.env.PAYMENT_CURRENCY || 'usd')
      .trim()
      .toLowerCase();

    let computedMinor = NaN;
    const itemsMinor = computeCartItemsMinor(cartItems);
    const shippingMinor = Number.isFinite(toNumber(shippingCost)) ? toAmountMinor(shippingCost) : 0;
    const taxMinor = Number.isFinite(toNumber(tax)) ? toAmountMinor(tax) : 0;

    if (Number.isFinite(itemsMinor)) {
      computedMinor = itemsMinor + shippingMinor + taxMinor;
    }

    let requestedMinor = NaN;
    if (Number.isFinite(toNumber(amountMinor))) {
      requestedMinor = Math.trunc(toNumber(amountMinor));
    } else if (Number.isFinite(toNumber(total))) {
      requestedMinor = toAmountMinor(total);
    } else if (Number.isFinite(computedMinor)) {
      requestedMinor = computedMinor;
    }

    if (!Number.isFinite(requestedMinor) || requestedMinor <= 0) {
      return res.status(400).json({
        error: 'Invalid amount',
        hint: 'Provide either amountMinor (integer cents) or total (number).',
      });
    }

    if (Number.isFinite(computedMinor) && Math.abs(requestedMinor - computedMinor) > 1) {
      return res.status(400).json({
        error: 'Amount mismatch',
        expectedAmountMinor: computedMinor,
        requestedAmountMinor: requestedMinor,
      });
    }

    const stripeAccount = process.env.STRIPE_ACCOUNT_ID ? String(process.env.STRIPE_ACCOUNT_ID).trim() : null;

    logger.info('Creating PaymentIntent', {
      amountMinor: requestedMinor,
      currency: currencyCode,
      orderId: orderId || null,
      stripeAccount: stripeAccount || null,
    });

    const intent = await stripe.paymentIntents.create(
      {
        amount: requestedMinor,
        currency: currencyCode,
        payment_method_types: ['card'],
        metadata: {
          orderId: orderId ? String(orderId) : '',
          customerEmail: customerEmail ? String(customerEmail) : '',
        },
      },
      stripeAccount ? { stripeAccount } : undefined
    );

    return res.json({
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
    });
  } catch (error) {
    const status = error?.statusCode || error?.status || 500;
    const message = error?.message || 'Failed to create payment intent';

    logger.error('PaymentIntent creation failed:', {
      status,
      message,
      type: error?.type,
      code: error?.code,
    });

    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: message });
    }

    return res.status(500).json({ error: message });
  }
});

export default router;
