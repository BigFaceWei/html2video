import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { prepareInput, startStaticServer } from '../src/assets.js';

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), 'asset-')); }

test('single html written as index.html', async () => {
  const dir = await tmp();
  await prepareInput({ inputDir: dir, kind: 'html', buffer: Buffer.from('<h1>hi</h1>') });
  const html = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /hi/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('zip extracted, requires index.html', async () => {
  const dir = await tmp();
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from('<b>ok</b>'));
  zip.addFile('a/style.css', Buffer.from('body{}'));
  await prepareInput({ inputDir: dir, kind: 'zip', buffer: zip.toBuffer() });
  assert.ok(await fs.readFile(path.join(dir, 'index.html'), 'utf8'));
  assert.ok(await fs.readFile(path.join(dir, 'a', 'style.css'), 'utf8'));
  await fs.rm(dir, { recursive: true, force: true });
});

test('zip-slip entry is rejected', async () => {
  const dir = await tmp();
  // adm-zip.addFile normalises '../evil.txt' → 'evil.txt' before storing,
  // so we must craft the raw zip bytes to preserve the traversal path,
  // simulating a zip produced by Python/Info-ZIP/other tools.
  const evilBuf = Buffer.from('x');
  const okBuf = Buffer.from('<b>ok</b>');
  function localHeader(name, data) {
    const n = Buffer.from(name); const h = Buffer.alloc(30 + n.length + data.length);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 8);
    h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26); n.copy(h, 30); data.copy(h, 30 + n.length); return h;
  }
  function centralEntry(name, offset, data) {
    const n = Buffer.from(name); const h = Buffer.alloc(46 + n.length);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6);
    h.writeUInt32LE(data.length, 20); h.writeUInt32LE(data.length, 24);
    h.writeUInt16LE(n.length, 28); h.writeUInt32LE(offset, 42); n.copy(h, 46); return h;
  }
  const lh1 = localHeader('../evil.txt', evilBuf), lh2 = localHeader('index.html', okBuf);
  const cd1 = centralEntry('../evil.txt', 0, evilBuf), cd2 = centralEntry('index.html', lh1.length, okBuf);
  const cdBuf = Buffer.concat([cd1, cd2]);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(2, 8); eocd.writeUInt16LE(2, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(lh1.length + lh2.length, 16);
  const zipBuf = Buffer.concat([lh1, lh2, cdBuf, eocd]);
  await assert.rejects(() => prepareInput({ inputDir: dir, kind: 'zip', buffer: zipBuf }), /unsafe/i);
  await fs.rm(dir, { recursive: true, force: true });
});

test('zip without index.html is rejected', async () => {
  const dir = await tmp();
  const zip = new AdmZip();
  zip.addFile('main.html', Buffer.from('<b>x</b>'));
  await assert.rejects(() => prepareInput({ inputDir: dir, kind: 'zip', buffer: zip.toBuffer() }), /index\.html/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('static server serves index.html', async () => {
  const dir = await tmp();
  await fs.writeFile(path.join(dir, 'index.html'), '<title>served</title>');
  const srv = await startStaticServer(dir);
  const res = await fetch(srv.url + '/index.html');
  const body = await res.text();
  assert.match(body, /served/);
  await srv.close();
  await fs.rm(dir, { recursive: true, force: true });
});
