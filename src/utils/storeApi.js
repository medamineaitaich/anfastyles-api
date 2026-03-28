import 'dotenv/config';
import axios from 'axios';
import logger from './logger.js';

let storeClient = null;

export const getStoreClient = () => {
  const storeUrl = process.env.WC_STORE_URL;
  if (!storeUrl) {
    throw new Error('Missing WC_STORE_URL');
  }

  if (!storeClient) {
    storeClient = axios.create({
      baseURL: `${String(storeUrl).replace(/\/+$/, '')}/wp-json/wc/store/v1`,
      timeout: 20000,
    });
  }

  return storeClient;
};

export const getStoreSessionFromHeaders = (headers = {}) => {
  const nonce = headers['nonce'] || headers['Nonce'] || null;
  const nonceTimestamp = headers['nonce-timestamp'] || headers['Nonce-Timestamp'] || null;
  const cartToken = headers['cart-token'] || headers['Cart-Token'] || null;
  const cartHash = headers['cart-hash'] || headers['Cart-Hash'] || null;

  return {
    nonce,
    nonceTimestamp,
    cartToken,
    cartHash,
  };
};

export const forwardStoreSessionHeaders = (req) => {
  const nonce = req.header('x-store-nonce') || req.header('Nonce') || req.header('nonce');
  const cartToken = req.header('x-store-cart-token') || req.header('Cart-Token') || req.header('cart-token');

  const headers = {};
  if (nonce) headers['Nonce'] = nonce;
  if (cartToken) headers['Cart-Token'] = cartToken;

  return headers;
};

export const handleStoreApiError = (error, context) => {
  if (error?.response) {
    const status = error.response.status || 500;
    const message = error.response.data?.message || error.response.data?.code || error.response.statusText || 'Store API error';
    logger.error(`Store API Error (${context}): ${status} ${message}`);
    const err = new Error(message);
    err.statusCode = status;
    err.details = error.response.data;
    throw err;
  }

  logger.error(`Store API Error (${context}):`, error?.message || error);
  const err = new Error(error?.message || 'Store API request failed');
  err.statusCode = 500;
  throw err;
};
