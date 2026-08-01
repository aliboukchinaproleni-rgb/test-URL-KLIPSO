import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { config } from './config.js';
import { registerRoutes } from './routes.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const publicDir = resolve(process.env.PUBLIC_DIR ?? 'public');

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

await app.register(fastifyStatic, { root: publicDir });
registerRoutes(app);

startScheduler();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopScheduler();
    app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: config.host });
