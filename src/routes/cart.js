import express from 'express';
import logger from '../utils/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { getWooCommerceCustomerSavedCart, saveWooCommerceCustomerSavedCart } from '../utils/woocommerce.js';

const router = express.Router();

const normalizeLineKey = (value) => String(value || '').trim();

const getAccountCart = (req) => getWooCommerceCustomerSavedCart(req.session.userId);

const saveAccountCart = async (req, cart) => {
  const savedCart = await saveWooCommerceCustomerSavedCart(req.session.userId, cart);
  return savedCart;
};

const respondWithCart = (res, cart) => res.json({
  success: true,
  cart,
});

// GET /cart/shipping - Calculate shipping cost
router.get('/shipping', (req, res) => {
  const { cartTotal } = req.query;

  if (!cartTotal) {
    return res.status(400).json({ error: 'cartTotal parameter is required' });
  }

  const total = parseFloat(cartTotal);
  const shippingCost = total >= 75 ? 0 : 10;

  logger.info(`Shipping calculated for cart total: $${total}, cost: $${shippingCost}`);

  res.json({
    cartTotal: total,
    shippingCost,
    isFreeShipping: shippingCost === 0,
  });
});

// GET /cart/account - Return the authenticated customer's saved cart
router.get('/account', requireAuth, async (req, res, next) => {
  try {
    const cart = await getAccountCart(req);
    return respondWithCart(res, cart);
  } catch (error) {
    return next(error);
  }
});

// PUT /cart/account - Persist the authenticated customer's saved cart
router.put('/account', requireAuth, async (req, res, next) => {
  try {
    const cart = await saveAccountCart(req, req.body?.cart || req.body || {});

    logger.info(`Saved account cart for customer ${req.session.userId} with ${cart.itemCount || 0} item(s)`);

    return respondWithCart(res, cart);
  } catch (error) {
    return next(error);
  }
});

// POST /cart/account/merge - Merge a guest cart into the authenticated customer's saved cart
router.post('/account/merge', requireAuth, async (req, res, next) => {
  try {
    const existingCart = await getAccountCart(req);
    const incomingCart = req.body?.cart || req.body || {};
    const cart = await saveAccountCart(req, {
      ...existingCart,
      items: [
        ...(Array.isArray(existingCart?.items) ? existingCart.items : []),
        ...(Array.isArray(incomingCart?.items) ? incomingCart.items : []),
      ],
    });

    logger.info(`Merged account cart for customer ${req.session.userId} with ${cart.itemCount || 0} item(s)`);

    return respondWithCart(res, cart);
  } catch (error) {
    return next(error);
  }
});

// POST /cart/account/items - Add one item to the authenticated customer's saved cart
router.post('/account/items', requireAuth, async (req, res, next) => {
  try {
    const item = req.body?.item || req.body || {};
    const lineKey = normalizeLineKey(item?.lineKey);
    const productId = Number(item?.productId) || 0;

    if (!lineKey || productId <= 0) {
      return res.status(400).json({ error: 'A valid cart item is required' });
    }

    const existingCart = await getAccountCart(req);
    const cart = await saveAccountCart(req, {
      ...existingCart,
      items: [
        ...(Array.isArray(existingCart?.items) ? existingCart.items : []),
        item,
      ],
    });

    return respondWithCart(res, cart);
  } catch (error) {
    return next(error);
  }
});

// PATCH /cart/account/items/:lineKey - Update quantity for one authenticated cart item
router.patch('/account/items/:lineKey', requireAuth, async (req, res, next) => {
  try {
    const lineKey = normalizeLineKey(req.params?.lineKey);
    const quantity = Number(req.body?.quantity);

    if (!lineKey) {
      return res.status(400).json({ error: 'A cart item line key is required' });
    }

    if (!Number.isFinite(quantity) || quantity < 1) {
      return res.status(400).json({ error: 'A valid quantity is required' });
    }

    const existingCart = await getAccountCart(req);
    const items = Array.isArray(existingCart?.items) ? existingCart.items : [];
    const hasMatch = items.some((item) => normalizeLineKey(item?.lineKey) === lineKey);

    if (!hasMatch) {
      return res.status(404).json({ error: 'Cart item not found' });
    }

    const cart = await saveAccountCart(req, {
      ...existingCart,
      items: items.map((item) => (
        normalizeLineKey(item?.lineKey) === lineKey
          ? { ...item, quantity }
          : item
      )),
    });

    return respondWithCart(res, cart);
  } catch (error) {
    return next(error);
  }
});

// DELETE /cart/account/items/:lineKey - Remove one authenticated cart item
router.delete('/account/items/:lineKey', requireAuth, async (req, res, next) => {
  try {
    const lineKey = normalizeLineKey(req.params?.lineKey);
    if (!lineKey) {
      return res.status(400).json({ error: 'A cart item line key is required' });
    }

    const existingCart = await getAccountCart(req);
    const items = Array.isArray(existingCart?.items) ? existingCart.items : [];
    const cart = await saveAccountCart(req, {
      ...existingCart,
      items: items.filter((item) => normalizeLineKey(item?.lineKey) !== lineKey),
    });

    return respondWithCart(res, cart);
  } catch (error) {
    return next(error);
  }
});

// DELETE /cart/account - Clear the authenticated customer's saved cart
router.delete('/account', requireAuth, async (req, res, next) => {
  try {
    const cart = await saveAccountCart(req, { items: [] });
    logger.info(`Cleared account cart for customer ${req.session.userId}`);
    return respondWithCart(res, cart);
  } catch (error) {
    return next(error);
  }
});

export default router;
