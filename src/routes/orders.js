import express from 'express';
import { createWooCommerceOrder, getWooCommerceOrder, getWooCommerceOrdersByCustomer } from '../utils/woocommerce.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = express.Router();

// POST /orders/create - Create new order
router.post('/create', async (req, res) => {
  const { cartItems, customerInfo, shippingMethod, paymentMethod } = req.body;

  if (!cartItems || !customerInfo || !shippingMethod || !paymentMethod) {
    return res.status(400).json({ error: 'Missing required order data' });
  }

  logger.info(`Creating order for customer: ${customerInfo.email}`);

  const lineItems = cartItems.map((item) => ({
    product_id: item.productId,
    quantity: item.quantity,
    price: item.price,
  }));

  const orderData = {
    customer_id: customerInfo.customerId || 0,
    billing: {
      first_name: customerInfo.firstName,
      last_name: customerInfo.lastName,
      email: customerInfo.email,
      phone: customerInfo.phone,
      address_1: customerInfo.address,
      city: customerInfo.city,
      state: customerInfo.state,
      postcode: customerInfo.zipCode,
      country: customerInfo.country || 'US',
    },
    shipping: {
      first_name: customerInfo.firstName,
      last_name: customerInfo.lastName,
      address_1: customerInfo.address,
      city: customerInfo.city,
      state: customerInfo.state,
      postcode: customerInfo.zipCode,
      country: customerInfo.country || 'US',
    },
    line_items: lineItems,
    shipping_lines: [
      {
        method_id: shippingMethod,
        method_title: shippingMethod,
      },
    ],
    payment_method: paymentMethod,
    payment_method_title: paymentMethod,
    status: 'pending',
  };

  const order = await createWooCommerceOrder(orderData);

  logger.info(`Order created: ${order.id}`);

  res.json({
    orderId: order.id,
    orderNumber: order.number,
  });
});

// GET /orders - Get customer orders (protected)
router.get('/', requireAuth, async (req, res) => {
  logger.info(`Fetching orders for user: ${req.session.userId}`);

  const orders = await getWooCommerceOrdersByCustomer(req.session.userId);

  res.json({
    orders: orders.map((order) => ({
      id: order.id,
      number: order.number,
      status: order.status,
      total: order.total,
      date: order.date_created,
      itemCount: order.line_items.length,
    })),
  });
});

// GET /orders/:id - Get order details (protected)
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  logger.info(`Fetching order ${id} for user: ${req.session.userId}`);

  const order = await getWooCommerceOrder(id);

  // Verify order belongs to authenticated user
  if (order.customer_id !== req.session.userId && order.customer_id !== 0) {
    logger.warn(`Unauthorized order access attempt for order ${id}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({
    id: order.id,
    number: order.number,
    status: order.status,
    total: order.total,
    subtotal: order.subtotal,
    shippingTotal: order.shipping_total,
    taxTotal: order.total_tax,
    date: order.date_created,
    items: order.line_items.map((item) => ({
      id: item.id,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
    })),
    billing: order.billing,
    shipping: order.shipping,
  });
});

// GET /orders/:id/tracking - Get order tracking info (protected)
router.get('/:id/tracking', requireAuth, async (req, res) => {
  const { id } = req.params;

  logger.info(`Fetching tracking info for order ${id}`);

  const order = await getWooCommerceOrder(id);

  // Verify order belongs to authenticated user
  if (order.customer_id !== req.session.userId && order.customer_id !== 0) {
    logger.warn(`Unauthorized tracking access attempt for order ${id}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({
    orderId: order.id,
    orderNumber: order.number,
    status: order.status,
    statusLabel: getStatusLabel(order.status),
    trackingNumber: order.meta_data?.find((m) => m.key === 'tracking_number')?.value || null,
    carrier: order.meta_data?.find((m) => m.key === 'carrier')?.value || null,
    estimatedDelivery: order.meta_data?.find((m) => m.key === 'estimated_delivery')?.value || null,
    lastUpdate: order.date_modified,
  });
});

const getStatusLabel = (status) => {
  const labels = {
    pending: 'Pending Payment',
    processing: 'Processing',
    'on-hold': 'On Hold',
    completed: 'Completed',
    cancelled: 'Cancelled',
    refunded: 'Refunded',
    failed: 'Failed',
  };
  return labels[status] || status;
};

export default router;
