import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';

import routes from './routes/index.js';
import { errorMiddleware } from './middleware/index.js';
import logger from './utils/logger.js';
import { initializeWooCommerceAPI } from './utils/woocommerce.js';

const app = express();

process.on('uncaughtException', (error) => {
	logger.error('Uncaught exception:', error?.stack || error);
});
  
process.on('unhandledRejection', (reason, promise) => {
	logger.error('Unhandled rejection at:', promise, 'reason:', reason?.stack || reason);
});

process.on('SIGINT', async () => {
	logger.info('Interrupted');
	process.exit(0);
});

process.on('SIGTERM', async () => {
	logger.info('SIGTERM signal received');

	await new Promise(resolve => setTimeout(resolve, 3000));

	logger.info('Exiting');
	process.exit();
});

app.use(helmet());
app.use(cors({
	origin: process.env.CORS_ORIGIN,
	credentials: true,
}));
app.use(morgan('combined'));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic root route for deployment smoke test
app.get('/', (_req, res) => {
	res.json({ ok: true, service: 'anfastyles-api' });
});

// Initialize WooCommerce API on startup (do not block server startup)
let wooInitialized = false;
try {
	initializeWooCommerceAPI();
	wooInitialized = true;
} catch (error) {
	// Keep the server alive so we can validate process startup/binding before debugging Woo routes.
	logger.error('WooCommerce init failed (server will still start):', error?.stack || error);
}

app.use('/', routes());

app.use(errorMiddleware);

app.use((req, res) => {
	res.status(404).json({ error: 'Route not found' });
});

const port = Number(process.env.PORT) || 3001;
const host = process.env.HOST || '0.0.0.0';

console.log(`[startup] service=anfastyles-api port=${port} host=${host} node_env=${process.env.NODE_ENV || 'undefined'} woo_initialized=${wooInitialized}`);
console.log(`[startup] cors_origin=${process.env.CORS_ORIGIN || 'undefined'}`);

const server = app.listen(port, host, () => {
	logger.info(`🚀 API Server started (port=${port}, host=${host})`);
});

server.on('error', (error) => {
	logger.error('Server listen error:', error?.stack || error);
	process.exit(1);
});

export default app;
