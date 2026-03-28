import express from 'express';
import logger from '../utils/logger.js';
import {
  getStoreClient,
  getStoreSessionFromHeaders,
  forwardStoreSessionHeaders,
  handleStoreApiError,
} from '../utils/storeApi.js';

const router = express.Router();

// GET /store/cart - Get cart data + session headers (nonce/cart-token)
router.get('/cart', async (req, res) => {
  try {
    const headers = forwardStoreSessionHeaders(req);
    const response = await getStoreClient().get('/cart', { headers });

    return res.json({
      data: response.data,
      store: getStoreSessionFromHeaders(response.headers),
    });
  } catch (error) {
    handleStoreApiError(error, 'GET /store/cart');
  }
});

// POST /store/cart/add-item - Add item (product or variation ID)
router.post('/cart/add-item', async (req, res) => {
  try {
    const headers = {
      ...forwardStoreSessionHeaders(req),
      'Content-Type': 'application/json',
    };

    const { id, quantity, variation } = req.body || {};
    const response = await getStoreClient().post('/cart/add-item', { id, quantity, variation }, { headers });

    return res.status(response.status).json({
      data: response.data,
      store: getStoreSessionFromHeaders(response.headers),
    });
  } catch (error) {
    handleStoreApiError(error, 'POST /store/cart/add-item');
  }
});

// POST /store/cart/update-customer - Persist billing/shipping (also triggers shipping rates)
router.post('/cart/update-customer', async (req, res) => {
  try {
    const headers = {
      ...forwardStoreSessionHeaders(req),
      'Content-Type': 'application/json',
    };

    const { billing_address, shipping_address } = req.body || {};
    const response = await getStoreClient().post('/cart/update-customer', { billing_address, shipping_address }, { headers });

    return res.status(response.status).json({
      data: response.data,
      store: getStoreSessionFromHeaders(response.headers),
    });
  } catch (error) {
    handleStoreApiError(error, 'POST /store/cart/update-customer');
  }
});

// GET /store/products/:id - Store API product (includes variations list)
router.get('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const response = await getStoreClient().get(`/products/${id}`);
    return res.json({ data: response.data });
  } catch (error) {
    handleStoreApiError(error, `GET /store/products/${req.params.id}`);
  }
});

// GET /store/checkout - Get draft checkout data
router.get('/checkout', async (req, res) => {
  try {
    const headers = forwardStoreSessionHeaders(req);
    const response = await getStoreClient().get('/checkout', { headers });

    return res.json({
      data: response.data,
      store: getStoreSessionFromHeaders(response.headers),
    });
  } catch (error) {
    handleStoreApiError(error, 'GET /store/checkout');
  }
});

// POST /store/checkout - Process order + payment via Store API
router.post('/checkout', async (req, res) => {
  try {
    const headers = {
      ...forwardStoreSessionHeaders(req),
      'Content-Type': 'application/json',
    };

    logger.info('Store checkout attempt');

    const response = await getStoreClient().post('/checkout', req.body || {}, { headers });

    return res.status(response.status).json({
      data: response.data,
      store: getStoreSessionFromHeaders(response.headers),
    });
  } catch (error) {
    handleStoreApiError(error, 'POST /store/checkout');
  }
});

export default router;

