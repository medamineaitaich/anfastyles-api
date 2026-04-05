import express from 'express';
import logger from '../utils/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { getWooCommerceCustomerSavedCart, saveWooCommerceCustomerSavedCart } from '../utils/woocommerce.js';

const router = express.Router();

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
    const cart = await getWooCommerceCustomerSavedCart(req.session.userId);

    return res.json({
      success: true,
      cart,
    });
  } catch (error) {
    return next(error);
  }
});

// PUT /cart/account - Persist the authenticated customer's saved cart
router.put('/account', requireAuth, async (req, res, next) => {
  try {
    const cart = await saveWooCommerceCustomerSavedCart(req.session.userId, req.body?.cart || req.body || {});

    logger.info(`Saved account cart for customer ${req.session.userId} with ${cart.itemCount || 0} item(s)`);

    return res.json({
      success: true,
      cart,
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
