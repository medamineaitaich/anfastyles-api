import express from 'express';
import { getProducts, getFeaturedProducts, getProductById, getProductReviews } from '../utils/woocommerce.js';
import logger from '../utils/logger.js';

const router = express.Router();

// GET /products - Fetch products with filters
router.get('/', async (req, res) => {
  const { category, priceMin, priceMax, sort, page, perPage } = req.query;

  logger.info('Fetching products with filters:', { category, priceMin, priceMax, sort, page, perPage });

  const filters = {
    category: category ? parseInt(category) : undefined,
    priceMin: priceMin ? parseFloat(priceMin) : undefined,
    priceMax: priceMax ? parseFloat(priceMax) : undefined,
    sort,
    page: page ? parseInt(page) : 1,
    perPage: perPage ? parseInt(perPage) : 20,
  };

  const result = await getProducts(filters);
  const products = result?.products || [];

  res.json({
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.images[0]?.src || null,
      rating: product.average_rating,
      reviewCount: product.review_count,
    })),
    page: filters.page,
    perPage: filters.perPage,
    total: result?.total ?? products.length,
    totalPages: result?.totalPages ?? undefined,
  });
});

// GET /products/featured - Fetch featured products
router.get('/featured', async (req, res) => {
  const { limit } = req.query;

  logger.info('Fetching featured products');

  const products = await getFeaturedProducts(limit ? parseInt(limit) : 10);

  res.json({
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.images[0]?.src || null,
      rating: product.average_rating,
      reviewCount: product.review_count,
    })),
  });
});

// GET /products/:id - Fetch single product with reviews
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  logger.info(`Fetching product ${id}`);

  const [product, reviews] = await Promise.all([
    getProductById(id),
    getProductReviews(id),
  ]);

  res.json({
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    regularPrice: product.regular_price,
    salePrice: product.sale_price,
    images: (product.images || []).map((img) => img.src),
    rating: product.average_rating,
    reviewCount: product.review_count,
    inStock: product.in_stock,
    stockQuantity: product.stock_quantity,
    sku: product.sku,
    attributes: product.normalizedAttributes || [],
    variations: product.normalizedVariations || [],
    reviews: (reviews || []).map((review) => ({
      id: review.id,
      rating: review.rating,
      review: review.review,
      reviewer: review.reviewer,
      date: review.date_created,
    })),
  });
});

export default router;
