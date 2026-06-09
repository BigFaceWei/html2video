import path from 'node:path';
import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

/**
 * Scan raw zip bytes for unsafe filenames (path traversal / absolute paths).
 * adm-zip silently normalises entry names on parse, so we must check the
 * raw local-file-header and central-directory filename fields before any
 * library processing.
 *
 * Throws an Error matching /unsafe/i if a dangerous filename is found.
 */
function assertNoZipSlip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  function checkName(name) {
    if (!name) return;
    // Absolute path or starts with ./.. sequence
    if (name.startsWith('/') || name.startsWith('\\')) {
      throw new Error(`unsafe zip entry path: ${name}`);
    }
    const parts = name.split(/[\\/]/);
    if (parts.includes('..')) {
      throw new Error(`unsafe zip entry path: ${name}`);
    }
  }

  let i = 0;
  while (i <= buf.length - 4) {
    const sig = buf.readUInt32LE(i);

    // Local file header: PK\x03\x04
    if (sig === 0x04034b50) {
      if (i + 30 > buf.length) break;
      const fnLen = buf.readUInt16LE(i + 26);
      if (i + 30 + fnLen <= buf.length) {
        const name = buf.slice(i + 30, i + 30 + fnLen).toString('utf8');
        checkName(name);
      }
      i += 4;
      continue;
    }

    // Central directory file header: PK\x01\x02
    if (sig === 0x02014b50) {
      if (i + 46 > buf.length) break;
      const fnLen = buf.readUInt16LE(i + 28);
      if (i + 46 + fnLen <= buf.length) {
        const name = buf.slice(i + 46, i + 46 + fnLen).toString('utf8');
        checkName(name);
      }
      i += 4;
      continue;
    }

    i++;
  }
}

// kind: 'html' | 'zip'；落盘到 inputDir，保证存在 index.html
export async function prepareInput({ inputDir, kind, buffer }) {
  await fs.mkdir(inputDir, { recursive: true });
  if (kind === 'html') {
    await fs.writeFile(path.join(inputDir, 'index.html'), buffer);
    return;
  }
  if (kind === 'zip') {
    // Raw-byte scan: catches traversal paths before adm-zip normalises them.
    assertNoZipSlip(buffer);

    const zip = new AdmZip(buffer);
    const root = path.resolve(inputDir);
    for (const entry of zip.getEntries()) {
      // Defence-in-depth: resolved-path check after library parse.
      const dest = path.resolve(inputDir, entry.entryName);
      if (dest !== root && !dest.startsWith(root + path.sep)) {
        throw new Error(`unsafe zip entry path: ${entry.entryName}`);
      }
      if (entry.isDirectory) { await fs.mkdir(dest, { recursive: true }); continue; }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, entry.getData());
    }
    try { await fs.access(path.join(inputDir, 'index.html')); }
    catch { throw new Error('zip must contain index.html at root'); }
    return;
  }
  throw new Error(`unknown input kind: ${kind}`);
}

// 起一个绑定 127.0.0.1 随机端口的静态服，根为 dir
export async function startStaticServer(dir) {
  const app = Fastify({ logger: false });
  app.register(fastifyStatic, { root: path.resolve(dir), prefix: '/' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  return { url: `http://127.0.0.1:${addr.port}`, close: () => app.close() };
}
