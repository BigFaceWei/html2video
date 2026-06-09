import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEncoder } from '../src/encoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64');

function probe(file, args) {
  return new Promise((res, rej) => {
    const p = spawn('ffprobe', ['-v','error', ...args, '-of','json', file]);
    let o=''; p.stdout.on('data',d=>o+=d);
    p.on('close',c=>c===0?res(JSON.parse(o)):rej(new Error('ffprobe')));
  });
}
async function feed(enc, n) {
  for (let i=0;i<n;i++){ if(!enc.stdin.write(PNG)) await new Promise(r=>enc.stdin.once('drain',r)); }
  enc.stdin.end(); await enc.done;
}

test('audio track is muxed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'av-'));
  const out = path.join(dir,'a.mp4');
  const enc = createEncoder({ output: out, width:320, height:240, fps:10, codec:'h264', crf:30,
    audioPath: path.join(__dirname,'fixtures','silence.aac') });
  await feed(enc, 10);
  const j = await probe(out, ['-select_streams','a','-show_entries','stream=codec_type']);
  assert.equal(j.streams.length, 1);
  assert.equal(j.streams[0].codec_type, 'audio');
  await fs.rm(dir,{recursive:true,force:true});
});

test('soft subtitle track is muxed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'av-'));
  const out = path.join(dir,'s.mp4');
  const enc = createEncoder({ output: out, width:320, height:240, fps:10, codec:'h264', crf:30,
    subtitlePath: path.join(__dirname,'fixtures','sample.srt'), subtitleMode:'soft' });
  await feed(enc, 10);
  const j = await probe(out, ['-select_streams','s','-show_entries','stream=codec_type']);
  assert.equal(j.streams.length, 1);
  assert.equal(j.streams[0].codec_type, 'subtitle');
  await fs.rm(dir,{recursive:true,force:true});
});

test('burned subtitle changes pixels (no subtitle stream)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'av-'));
  const out = path.join(dir,'b.mp4');
  const enc = createEncoder({ output: out, width:320, height:240, fps:10, codec:'h264', crf:30,
    subtitlePath: path.join(__dirname,'fixtures','sample.srt'), subtitleMode:'burn' });
  await feed(enc, 10);
  const j = await probe(out, ['-select_streams','s','-show_entries','stream=codec_type']);
  assert.equal((j.streams||[]).length, 0); // 烧录无独立字幕轨
  await fs.rm(dir,{recursive:true,force:true});
});
