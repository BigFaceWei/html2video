import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import os from 'node:os';
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
  const interfaces = os.networkInterfaces();
  const lanIp = Object.values(interfaces).flat().find(i => !i.internal && i.family === 'IPv4')?.address;
  app.listen({ port, host: '0.0.0.0' })
    .then(() => {
      console.log(`html2video on http://127.0.0.1:${port}`);
      if (lanIp) console.log(`       LAN on http://${lanIp}:${port}`);
    })
    .catch((e) => { console.error(e); process.exit(1); });
}
