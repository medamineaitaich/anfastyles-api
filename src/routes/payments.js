import express from 'express';
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

