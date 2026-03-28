import { Router } from 'express';
import healthCheck from './health-check.js';
import productsRouter from './products.js';
import authRouter from './auth.js';
import ordersRouter from './orders.js';
import cartRouter from './cart.js';
import contactRouter from './contact.js';
import paymentsRouter from './payments.js';
import storeRouter from './store.js';

const router = Router();

export default () => {
  router.get('/health', healthCheck);
  router.use('/products', productsRouter);
  router.use('/auth', authRouter);
  router.use('/orders', ordersRouter);
  router.use('/cart', cartRouter);
  router.use('/contact', contactRouter);
  router.use('/payments', paymentsRouter);
  router.use('/store', storeRouter);

  return router;
};
