import 'dotenv/config';
import axios from 'axios';
import logger from './logger.js';

const requiredEnvVars = ['WC_STORE_URL', 'WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET'];

const validateCredentials = () => {
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing WooCommerce credentials: ${missing.join(', ')}`);
  }

  logger.info('WooCommerce API credentials validated');
};

const getRequiredEnv = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var: ${name}`);
  return String(value);
};

let wcClient;
let wpClient;

const getWcClient = () => {
  if (wcClient) return wcClient;

  validateCredentials();

  const storeUrl = getRequiredEnv('WC_STORE_URL').replace(/\/+$/, '');
  const consumerKey = getRequiredEnv('WC_CONSUMER_KEY');
  const consumerSecret = getRequiredEnv('WC_CONSUMER_SECRET');
  const credentials = `${consumerKey}:${consumerSecret}`;

  wcClient = axios.create({
    baseURL: `${storeUrl}/wp-json/wc/v3`,
    headers: {
      Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
      'Content-Type': 'application/json',
    },
  });

  return wcClient;
};

const getWpClient = () => {
  if (wpClient) return wpClient;

  const storeUrl = getRequiredEnv('WC_STORE_URL').replace(/\/+$/, '');
  wpClient = axios.create({
    baseURL: `${storeUrl}/wp-json/wp/v2`,
  });

  return wpClient;
};

// Error handler for API calls
const handleApiError = (error, context) => {
  if (error.response) {
    const status = error.response.status;
    const message = error.response.data?.message || error.response.statusText;
    
    if (status === 401 || status === 403) {
      logger.error(`WooCommerce API Auth Error (${context}): ${message}`);
      throw new Error(`WooCommerce API authentication failed: ${message}`);
    }
    
    logger.error(`WooCommerce API Error (${context}): ${status} ${message}`);
    throw new Error(`WooCommerce API error: ${message}`);
  }
  
  logger.error(`WooCommerce API Error (${context}):`, error.message);
  throw new Error(`Failed to connect to WooCommerce API: ${error.message}`);
};

// WooCommerce API calls
export const getProducts = async (filters = {}) => {
  try {
    const params = {};

    if (filters.category) params.category = filters.category;
    if (filters.priceMin) params.min_price = filters.priceMin;
    if (filters.priceMax) params.max_price = filters.priceMax;
    if (filters.sort) {
      switch (filters.sort) {
        case 'popularity':
          params.orderby = 'popularity';
          break;
        case 'newest':
          params.orderby = 'date';
          params.order = 'desc';
          break;
        case 'price':
          params.orderby = 'price';
          break;
        default:
          break;
      }
    }

    params.page = filters.page || 1;
    params.per_page = filters.perPage || 20;
    params.status = 'publish';

    const response = await getWcClient().get('/products', { params });
    return response.data;
  } catch (error) {
    handleApiError(error, 'getProducts');
  }
};

export const getFeaturedProducts = async (limit = 10) => {
  try {
    const response = await getWcClient().get('/products', {
      params: {
        featured: true,
        per_page: limit,
        status: 'publish',
      },
    });
    return response.data;
  } catch (error) {
    handleApiError(error, 'getFeaturedProducts');
  }
};

export const getProductById = async (productId) => {
  try {
    const response = await getWcClient().get(`/products/${productId}`);
    return response.data;
  } catch (error) {
    handleApiError(error, `getProductById(${productId})`);
  }
};

export const getProductReviews = async (productId) => {
  try {
    const response = await getWcClient().get(`/products/${productId}/reviews`);
    return response.data;
  } catch (error) {
    handleApiError(error, `getProductReviews(${productId})`);
  }
};

export const createWooCommerceCustomer = async (customerData) => {
  try {
    const response = await getWcClient().post('/customers', {
      email: customerData.email,
      first_name: customerData.firstName || '',
      last_name: customerData.lastName || '',
      username: customerData.email.split('@')[0],
      password: customerData.password,
    });
    return response.data;
  } catch (error) {
    handleApiError(error, 'createWooCommerceCustomer');
  }
};

export const createWooCommerceOrder = async (orderData) => {
  try {
    const response = await getWcClient().post('/orders', orderData);
    return response.data;
  } catch (error) {
    handleApiError(error, 'createWooCommerceOrder');
  }
};

export const getWooCommerceOrder = async (orderId) => {
  try {
    const response = await getWcClient().get(`/orders/${orderId}`);
    return response.data;
  } catch (error) {
    handleApiError(error, `getWooCommerceOrder(${orderId})`);
  }
};

export const getWooCommerceOrdersByCustomer = async (customerId) => {
  try {
    const response = await getWcClient().get('/orders', {
      params: {
        customer: customerId,
      },
    });
    return response.data;
  } catch (error) {
    handleApiError(error, `getWooCommerceOrdersByCustomer(${customerId})`);
  }
};

// WordPress API calls
export const getWordPressUsers = async (search) => {
  try {
    const response = await getWpClient().get('/users', {
      params: {
        search,
      },
    });
    return response.data;
  } catch (error) {
    handleApiError(error, 'getWordPressUsers');
  }
};

export const verifyWordPressUser = async (email, password) => {
  try {
    const storeUrl = getRequiredEnv('WC_STORE_URL').replace(/\/+$/, '');
    const response = await axios.post(
      `${storeUrl}/wp-json/jwt-auth/v1/token`,
      {
        username: email,
        password,
      }
    );
    return response.data;
  } catch (error) {
    logger.error('WordPress user verification failed:', error.message);
    throw new Error('Invalid credentials');
  }
};

// Export validation function for startup
export const initializeWooCommerceAPI = () => {
  validateCredentials();
  getWcClient();
};

export default {
  getProducts,
  getFeaturedProducts,
  getProductById,
  getProductReviews,
  createWooCommerceCustomer,
  createWooCommerceOrder,
  getWooCommerceOrder,
  getWooCommerceOrdersByCustomer,
  getWordPressUsers,
  verifyWordPressUser,
  initializeWooCommerceAPI,
};
