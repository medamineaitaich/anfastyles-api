import 'dotenv/config';
import axios from 'axios';
import crypto from 'node:crypto';
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
const MAX_WP_USERNAME_LENGTH = 60;
const SAVED_CART_META_KEY = '_anfastyles_saved_cart';

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

const normalizeEmailAddress = (value) => String(value || '').trim().toLowerCase();

const sanitizeWooCommerceUsernamePart = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[^\x00-\x7F]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-')
  .replace(/[-._]{2,}/g, '-')
  .replace(/^[-._]+|[-._]+$/g, '');

export const buildWooCommerceUsername = (email) => {
  const normalizedEmail = normalizeEmailAddress(email);
  const [rawLocalPart = 'customer'] = normalizedEmail.split('@');
  const baseUsername = sanitizeWooCommerceUsernamePart(rawLocalPart) || 'customer';
  const uniqueSuffix = crypto
    .createHash('sha256')
    .update(normalizedEmail)
    .digest('hex')
    .slice(0, 8);
  const maxBaseLength = Math.max(1, MAX_WP_USERNAME_LENGTH - uniqueSuffix.length - 1);
  const truncatedBase = baseUsername.slice(0, maxBaseLength) || 'customer';

  return `${truncatedBase}-${uniqueSuffix}`;
};

const sanitizeSavedCartItem = (item = {}) => ({
  ...item,
  lineKey: String(item.lineKey || '').trim(),
  productId: Number(item.productId) || 0,
  variationId: Number(item.variationId) || 0,
  sku: String(item.sku || '').trim(),
  name: String(item.name || '').trim(),
  price: Number.parseFloat(item.price) || 0,
  image: String(item.image || '').trim(),
  quantity: Math.max(1, Number(item.quantity) || 1),
  size: String(item.size || '').trim(),
  color: String(item.color || '').trim(),
}).valueOf();

const normalizeSavedCartPayload = (cart = {}) => {
  const items = Array.isArray(cart?.items)
    ? [...cart.items
      .map((item) => sanitizeSavedCartItem(item))
      .filter((item) => item.lineKey && item.productId > 0 && item.quantity > 0)
      .reduce((itemMap, item) => {
        const existingItem = itemMap.get(item.lineKey);

        if (existingItem) {
          itemMap.set(item.lineKey, {
            ...existingItem,
            ...item,
            quantity: existingItem.quantity + item.quantity,
          });
        } else {
          itemMap.set(item.lineKey, item);
        }

        return itemMap;
      }, new Map()).values()]
    : [];

  const subtotal = items.reduce((sum, item) => sum + ((Number(item.price) || 0) * item.quantity), 0);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
  const updatedAt = String(cart?.updatedAt || new Date().toISOString()).trim() || new Date().toISOString();

  return {
    items,
    subtotal,
    itemCount,
    updatedAt,
  };
};

const getCustomerMetaEntries = (customer = {}) => (
  Array.isArray(customer?.meta_data) ? customer.meta_data : []
);

const getSavedCartMetaEntry = (customer = {}) => (
  getCustomerMetaEntries(customer).find((entry) => String(entry?.key || '').trim() === SAVED_CART_META_KEY) || null
);

const parseSavedCartMetaValue = (value) => {
  if (!value) return normalizeSavedCartPayload();

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return normalizeSavedCartPayload(parsed);
  } catch {
    return normalizeSavedCartPayload();
  }
};

const isWooCommerceUsernameConflict = (error) => {
  const message = String(error?.response?.data?.message || error?.message || '').toLowerCase();
  return message.includes('username') && (
    message.includes('already registered')
    || message.includes('already exists')
    || message.includes('please choose another')
  );
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
  const normalizedEmail = normalizeEmailAddress(customerData?.email);

  try {
    const response = await getWcClient().post('/customers', {
      email: normalizedEmail,
      first_name: customerData.firstName || '',
      last_name: customerData.lastName || '',
      username: buildWooCommerceUsername(normalizedEmail),
      password: customerData.password,
      ...(customerData.billing ? { billing: customerData.billing } : {}),
      ...(customerData.shipping ? { shipping: customerData.shipping } : {}),
    });
    return response.data;
  } catch (error) {
    if (isWooCommerceUsernameConflict(error)) {
      const conflictError = new Error('We could not create this account because the generated username is already taken. Please try again.');
      conflictError.statusCode = 409;
      conflictError.code = 'username_conflict';
      conflictError.details = error?.response?.data || null;
      throw conflictError;
    }

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

export const getWooCommerceCustomerById = async (customerId) => {
  try {
    const normalizedCustomerId = Number.parseInt(customerId, 10);
    if (!Number.isInteger(normalizedCustomerId) || normalizedCustomerId <= 0) {
      throw new Error('A valid WooCommerce customer id is required');
    }

    const response = await getWcClient().get(`/customers/${normalizedCustomerId}`);
    return response.data;
  } catch (error) {
    handleApiError(error, `getWooCommerceCustomerById(${customerId})`);
  }
};

export const updateWooCommerceCustomer = async (customerId, customerData = {}) => {
  try {
    const normalizedCustomerId = Number.parseInt(customerId, 10);
    if (!Number.isInteger(normalizedCustomerId) || normalizedCustomerId <= 0) {
      throw new Error('A valid WooCommerce customer id is required');
    }

    const payload = {};

    if (customerData.email !== undefined) payload.email = normalizeEmailAddress(customerData.email);
    if (customerData.firstName !== undefined) payload.first_name = customerData.firstName || '';
    if (customerData.lastName !== undefined) payload.last_name = customerData.lastName || '';
    if (customerData.password !== undefined) payload.password = String(customerData.password || '');
    if (customerData.billing) payload.billing = customerData.billing;
    if (customerData.shipping) payload.shipping = customerData.shipping;
    if (Array.isArray(customerData.metaData)) payload.meta_data = customerData.metaData;

    const response = await getWcClient().put(`/customers/${normalizedCustomerId}`, payload);
    return response.data;
  } catch (error) {
    handleApiError(error, `updateWooCommerceCustomer(${customerId})`);
  }
};

export const getWooCommerceCustomerSavedCart = async (customerId) => {
  const customer = await getWooCommerceCustomerById(customerId);
  const savedCartEntry = getSavedCartMetaEntry(customer);

  return parseSavedCartMetaValue(savedCartEntry?.value);
};

export const saveWooCommerceCustomerSavedCart = async (customerId, cart = {}) => {
  const customer = await getWooCommerceCustomerById(customerId);
  const normalizedCart = normalizeSavedCartPayload(cart);
  const existingMetaEntries = getCustomerMetaEntries(customer);
  const existingSavedCartEntry = getSavedCartMetaEntry(customer);
  const nextMetaEntries = existingMetaEntries
    .filter((entry) => String(entry?.key || '').trim() !== SAVED_CART_META_KEY)
    .map((entry) => {
      const nextEntry = {
        key: entry?.key,
        value: entry?.value,
      };

      if (entry?.id !== undefined) nextEntry.id = entry.id;
      return nextEntry;
    });

  nextMetaEntries.push({
    ...(existingSavedCartEntry?.id !== undefined ? { id: existingSavedCartEntry.id } : {}),
    key: SAVED_CART_META_KEY,
    value: JSON.stringify(normalizedCart),
  });

  const updatedCustomer = await updateWooCommerceCustomer(customerId, {
    metaData: nextMetaEntries,
  });

  const updatedSavedCartEntry = getSavedCartMetaEntry(updatedCustomer);
  return parseSavedCartMetaValue(updatedSavedCartEntry?.value || normalizedCart);
};

export const createWooCommerceOrder = async (orderData) => {
  try {
    const response = await getWcClient().post('/orders', orderData);
    return response.data;
  } catch (error) {
    handleApiError(error, 'createWooCommerceOrder');
  }
};

export const updateWooCommerceOrder = async (orderId, orderData) => {
  try {
    const response = await getWcClient().put(`/orders/${orderId}`, orderData);
    return response.data;
  } catch (error) {
    handleApiError(error, `updateWooCommerceOrder(${orderId})`);
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

export const triggerWordPressPasswordReset = async (loginOrEmail) => {
  try {
    const resetUrl = `${process.env.WC_STORE_URL}/wp-login.php?action=lostpassword`;

    const body = new URLSearchParams();
    body.set('user_login', String(loginOrEmail || '').trim());
    body.set('wp-submit', 'Get New Password');
    body.set('redirect_to', `${process.env.WC_STORE_URL}/my-account/lost-password/`);

    const response = await axios.post(resetUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    return {
      accepted: true,
      status: response.status,
    };
  } catch (error) {
    logger.error('WordPress password reset trigger failed:', error.message);
    throw new Error('Unable to trigger password reset email');
  }
};

export const resetWordPressPassword = async ({ key, login, password, confirmPassword }) => {
  try {
    const normalizedKey = String(key || '').trim();
    const normalizedLogin = String(login || '').trim();
    const nextPassword = String(password || '');
    const nextConfirmPassword = String(confirmPassword || nextPassword);

    if (!normalizedKey || !normalizedLogin) {
      throw new Error('Reset key and login are required');
    }

    const resetEntryUrl = `${process.env.WC_STORE_URL}/wp-login.php?action=rp&key=${encodeURIComponent(normalizedKey)}&login=${encodeURIComponent(normalizedLogin)}`;
    const resetEntryResponse = await axios.get(resetEntryUrl, {
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const setCookie = resetEntryResponse.headers?.['set-cookie'] || [];
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const resetCookie = cookies
      .map((cookie) => String(cookie || '').split(';')[0])
      .find((cookie) => cookie.toLowerCase().startsWith('wp-resetpass-'));

    if (!resetCookie) {
      throw new Error('Invalid or expired reset link');
    }

    const resetSubmitUrl = `${process.env.WC_STORE_URL}/wp-login.php?action=resetpass`;
    const body = new URLSearchParams();
    body.set('pass1', nextPassword);
    body.set('pass2', nextConfirmPassword);
    body.set('rp_key', normalizedKey);
    body.set('wp-submit', 'Save Password');

    const resetSubmitResponse = await axios.post(resetSubmitUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: resetCookie,
      },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const responseBody = String(resetSubmitResponse.data || '');
    if (/Your password has been reset\./i.test(responseBody)) {
      return { reset: true, status: resetSubmitResponse.status };
    }

    if (/passwords do not match/i.test(responseBody)) {
      throw new Error('Passwords do not match');
    }

    if (/invalidkey|expiredkey/i.test(responseBody) || /invalid or expired/i.test(responseBody)) {
      throw new Error('Invalid or expired reset link');
    }

    throw new Error('Unable to reset password');
  } catch (error) {
    if (/Reset key and login are required|Passwords do not match|Invalid or expired reset link|Unable to reset password/i.test(error.message || '')) {
      throw error;
    }

    logger.error('WordPress password reset failed:', error.message);
    throw new Error('Unable to reset password');
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
  buildWooCommerceUsername,
  createWooCommerceCustomer,
  getWooCommerceCustomerByEmail,
  getWooCommerceCustomerById,
  updateWooCommerceCustomer,
  getWooCommerceCustomerSavedCart,
  saveWooCommerceCustomerSavedCart,
  createWooCommerceOrder,
  updateWooCommerceOrder,
  getWooCommerceOrder,
  getWooCommerceOrdersByCustomer,
  getWordPressUsers,
  verifyWordPressUser,
  triggerWordPressPasswordReset,
  resetWordPressPassword,
  initializeWooCommerceAPI,
};
