import 'dotenv/config';
import axios from 'axios';
import logger from './logger.js';

// Validate credentials on startup
const validateCredentials = () => {
  const requiredEnvVars = ['WC_STORE_URL', 'WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET'];
  const missing = requiredEnvVars.filter(v => !process.env[v]);
  
  if (missing.length > 0) {
    throw new Error(`Missing WooCommerce credentials: ${missing.join(', ')}`);
  }
  
  logger.info('✓ WooCommerce API credentials validated successfully');
};

// Create Basic Auth header
const createBasicAuthHeader = () => {
  const credentials = `${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
};

let wcClient = null;
let wpClient = null;
const productCategoryCache = new Map();

const VARIATIONS_PER_PAGE = 100;

// Create clients lazily so startup failures point at missing env vars clearly.
const getWcClient = () => {
  if (!wcClient) {
    wcClient = axios.create({
      baseURL: `${process.env.WC_STORE_URL}/wp-json/wc/v3`,
      headers: {
        'Authorization': createBasicAuthHeader(),
        'Content-Type': 'application/json',
      },
    });
  }
  return wcClient;
};

const getWpClient = () => {
  if (!wpClient) {
    wpClient = axios.create({
      baseURL: `${process.env.WC_STORE_URL}/wp-json/wp/v2`,
    });
  }
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

const getImageSrc = (image) => {
  if (typeof image === 'string') return image || null;
  return image?.src || null;
};

const normalizeCategoryFilterValue = (value) => String(value || '')
  .trim()
  .toLowerCase()
  .replace(/[_\s]+/g, '-');

const findProductCategoryId = async (value) => {
  const normalizedValue = normalizeCategoryFilterValue(value);
  if (!normalizedValue) return null;

  if (productCategoryCache.has(normalizedValue)) {
    return productCategoryCache.get(normalizedValue);
  }

  const requests = [
    getWcClient().get('/products/categories', {
      params: {
        slug: normalizedValue,
        per_page: 100,
      },
    }),
  ];

  if (!/^\d+$/.test(normalizedValue)) {
    requests.push(
      getWcClient().get('/products/categories', {
        params: {
          search: String(value || '').trim(),
          per_page: 100,
        },
      })
    );
  }

  const responses = await Promise.all(requests);
  const categories = responses.flatMap((response) => Array.isArray(response?.data) ? response.data : []);

  const matchedCategory = categories.find((category) => normalizeCategoryFilterValue(category?.slug) === normalizedValue)
    || categories.find((category) => normalizeCategoryFilterValue(category?.name) === normalizedValue)
    || categories.find((category) => normalizeCategoryFilterValue(category?.slug).includes(normalizedValue))
    || categories.find((category) => normalizeCategoryFilterValue(category?.name).includes(normalizedValue))
    || null;

  const matchedId = matchedCategory?.id ? String(matchedCategory.id) : null;
  productCategoryCache.set(normalizedValue, matchedId);
  return matchedId;
};

const resolveProductCategoryFilter = async (value) => {
  const rawValue = String(value || '').trim();
  if (!rawValue) return undefined;

  const tokens = rawValue.split(',').map((token) => token.trim()).filter(Boolean);
  const resolvedTokens = [];

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      resolvedTokens.push(token);
      continue;
    }

    const matchedId = await findProductCategoryId(token);
    if (matchedId) resolvedTokens.push(matchedId);
  }

  return resolvedTokens.length > 0 ? resolvedTokens.join(',') : undefined;
};

const toDisplayAttributeName = (value) => String(value || '')
  .replace(/^pa_/, '')
  .replace(/[_-]+/g, ' ')
  .trim()
  .replace(/\b\w/g, (char) => char.toUpperCase());

const createAttributeLookup = (productAttributes = []) => {
  const bySlug = new Map();
  const byName = new Map();

  for (const attribute of productAttributes) {
    const name = String(attribute?.name || '').trim();
    const slug = String(attribute?.slug || '').trim();

    const normalized = {
      name: name || toDisplayAttributeName(slug),
      slug: slug || name,
      options: Array.isArray(attribute?.options)
        ? attribute.options
          .map((option) => String(option || '').trim())
          .filter(Boolean)
        : [],
      variation: Boolean(attribute?.variation),
    };

    if (normalized.slug) {
      bySlug.set(normalized.slug.toLowerCase(), normalized);
    }

    if (normalized.name) {
      byName.set(normalized.name.toLowerCase(), normalized);
    }
  }

  return { bySlug, byName };
};

const normalizeVariationAttributes = (variationAttributes = [], attributeLookup) => {
  const selections = (variationAttributes || []).map((attribute) => {
    const rawName = String(attribute?.name || '').trim();
    const rawSlug = rawName.toLowerCase();
    const rawOption = String(attribute?.option || '').trim();
    const matchedAttribute = attributeLookup.bySlug.get(rawSlug) || attributeLookup.byName.get(rawSlug);

    return {
      name: matchedAttribute?.name || toDisplayAttributeName(rawName),
      slug: matchedAttribute?.slug || rawName,
      option: rawOption,
    };
  }).filter((attribute) => attribute.name && attribute.slug);

  return {
    attributes: Object.fromEntries(
      selections
        .filter((attribute) => attribute.option)
        .map((attribute) => [attribute.name, attribute.option])
    ),
    attributeSelections: selections,
  };
};

const normalizeProductAttributes = (productAttributes = [], variations = []) => {
  const variationAttributes = productAttributes
    .filter((attribute) => attribute?.variation)
    .map((attribute) => {
      const name = String(attribute?.name || '').trim();
      const slug = String(attribute?.slug || '').trim() || name;
      const nameKey = name.toLowerCase();
      const slugKey = slug.toLowerCase();
      const optionSet = new Set(
        (Array.isArray(attribute?.options) ? attribute.options : [])
          .map((option) => String(option || '').trim())
          .filter(Boolean)
      );

      for (const variation of variations) {
        for (const selection of variation?.attributeSelections || []) {
          const selectionSlugKey = String(selection.slug || '').toLowerCase();
          const selectionNameKey = String(selection.name || '').toLowerCase();

          if (selectionSlugKey === slugKey || selectionNameKey === nameKey) {
            if (selection.option) optionSet.add(selection.option);
          }
        }
      }

      return {
        name: name || toDisplayAttributeName(slug),
        slug,
        options: Array.from(optionSet),
      };
    })
    .filter((attribute) => attribute.name && attribute.slug);

  if (variationAttributes.length > 0) {
    return variationAttributes;
  }

  const derivedAttributes = new Map();

  for (const variation of variations) {
    for (const selection of variation?.attributeSelections || []) {
      if (!selection.slug || !selection.name) continue;

      const existing = derivedAttributes.get(selection.slug) || {
        name: selection.name,
        slug: selection.slug,
        options: [],
      };

      if (selection.option && !existing.options.includes(selection.option)) {
        existing.options.push(selection.option);
      }

      derivedAttributes.set(selection.slug, existing);
    }
  }

  return Array.from(derivedAttributes.values());
};

const normalizeVariation = (variation, attributeLookup) => {
  const normalizedAttributes = normalizeVariationAttributes(variation?.attributes || [], attributeLookup);
  const stockStatus = variation.stock_status || (variation.in_stock ? 'instock' : 'outofstock');

  return {
    id: variation.id,
    sku: variation.sku || '',
    price: variation.price ?? '',
    regularPrice: variation.regular_price ?? '',
    salePrice: variation.sale_price ?? '',
    inStock: stockStatus === 'instock',
    stockStatus,
    stockQuantity: variation.stock_quantity ?? null,
    image: getImageSrc(variation.image),
    attributes: normalizedAttributes.attributes,
    attributeSelections: normalizedAttributes.attributeSelections,
  };
};

const getProductVariations = async (productId) => {
  const variations = [];
  let page = 1;

  while (true) {
    const response = await getWcClient().get(`/products/${productId}/variations`, {
      params: {
        page,
        per_page: VARIATIONS_PER_PAGE,
      },
    });

    const currentPageVariations = Array.isArray(response.data) ? response.data : [];
    const totalPages = parseInt(response.headers?.['x-wp-totalpages'] || '0', 10) || 0;

    variations.push(...currentPageVariations);

    if (totalPages > 0) {
      if (page >= totalPages) break;
    } else if (currentPageVariations.length < VARIATIONS_PER_PAGE) {
      break;
    }

    page += 1;
  }

  return variations;
};

// WooCommerce API calls
export const getProducts = async (filters = {}) => {
  try {
    const params = {};

    if (filters.category) {
      const resolvedCategory = await resolveProductCategoryFilter(filters.category);
      if (resolvedCategory) params.category = resolvedCategory;
    }
    if (filters.priceMin) params.min_price = filters.priceMin;
    if (filters.priceMax) params.max_price = filters.priceMax;
    if (filters.search) params.search = filters.search;
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
        case 'price_asc':
          params.orderby = 'price';
          params.order = 'asc';
          break;
        case 'price_desc':
          params.orderby = 'price';
          params.order = 'desc';
          break;
        default:
          break;
      }
    }

    params.page = filters.page || 1;
    params.per_page = filters.perPage || 20;
    params.status = 'publish';

    const response = await getWcClient().get('/products', { params });
    const total = parseInt(response.headers?.['x-wp-total'] || '0', 10) || 0;
    const totalPages = parseInt(response.headers?.['x-wp-totalpages'] || '0', 10) || 0;

    return {
      products: response.data,
      total,
      totalPages,
    };
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
    const product = response.data;

    if (product?.type !== 'variable') {
      return {
        ...product,
        normalizedAttributes: [],
        normalizedVariations: [],
      };
    }

    const attributeLookup = createAttributeLookup(product.attributes || []);
    const variationResponse = await getProductVariations(productId);
    const normalizedVariations = variationResponse.map((variation) => normalizeVariation(variation, attributeLookup));
    const normalizedAttributes = normalizeProductAttributes(product.attributes || [], normalizedVariations);

    return {
      ...product,
      normalizedAttributes,
      normalizedVariations,
    };
  } catch (error) {
    handleApiError(error, `getProductById(${productId})`);
  }
};

export const getProductReviews = async (productId) => {
  try {
    const response = await getWcClient().get('/products/reviews', {
      params: {
        product: productId,
      },
    });
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

export const getWooCommerceCustomerByEmail = async (email) => {
  try {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return null;

    const response = await getWcClient().get('/customers', {
      params: {
        email: normalizedEmail,
      },
    });

    const customers = Array.isArray(response.data) ? response.data : [];
    return customers.find((c) => String(c?.email || '').trim().toLowerCase() === normalizedEmail) || customers[0] || null;
  } catch (error) {
    handleApiError(error, `getWooCommerceCustomerByEmail(${email})`);
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

export const verifyWordPressUser = async (login, password) => {
  try {
    const loginUrl = `${process.env.WC_STORE_URL}/wp-login.php`;

    const body = new URLSearchParams();
    body.set('log', String(login || '').trim());
    body.set('pwd', password);
    body.set('wp-submit', 'Log In');
    body.set('redirect_to', `${process.env.WC_STORE_URL}/wp-admin/`);
    body.set('testcookie', '1');

    const response = await axios.post(loginUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      // WordPress typically redirects (302) on success.
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const setCookie = response.headers?.['set-cookie'] || [];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    // Some platforms may coalesce multiple Set-Cookie headers into a single comma-separated string.
    // Match by substring to be resilient (also covers "__Secure-wordpress_logged_in...").
    const hasLoginCookie = cookies.some((c) => String(c).toLowerCase().includes('wordpress_logged_in'));

    if (!hasLoginCookie) {
      throw new Error('Invalid credentials');
    }

    return { authenticated: true };
  } catch (error) {
    logger.error('WordPress user verification failed:', error.message);
    throw new Error('Invalid credentials');
  }
};

// Export validation function for startup
export const initializeWooCommerceAPI = () => {
  validateCredentials();
  getWcClient();
  getWpClient();
};

export default {
  getProducts,
  getFeaturedProducts,
  getProductById,
  getProductReviews,
  createWooCommerceCustomer,
  getWooCommerceCustomerByEmail,
  createWooCommerceOrder,
  getWooCommerceOrder,
  getWooCommerceOrdersByCustomer,
  getWordPressUsers,
  verifyWordPressUser,
  initializeWooCommerceAPI,
};
