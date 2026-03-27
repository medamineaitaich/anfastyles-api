import express from 'express';
import logger from '../utils/logger.js';

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

export default router;
