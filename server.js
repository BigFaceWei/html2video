import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 * 1024 });
  app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024 } });
  app.register(fastifyStatic, { root: path.join(__dirname, 'web'), prefix: '/' });
  app.register(registerRoutes);
  return app;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const app = buildServer();
  const port = Number(process.env.PORT || 3000);
  app.listen({ port, host: '127.0.0.1' })
    .then(() => console.log(`html2video on http://127.0.0.1:${port}`))
    .catch((e) => { console.error(e); process.exit(1); });
}
