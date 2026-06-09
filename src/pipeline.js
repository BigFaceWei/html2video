import path from 'node:path';
import { prepareInput, startStaticServer } from './assets.js';
import { renderFrames } from './renderer.js';
import { createEncoder } from './encoder.js';

// files: { html?:Buffer, zip?:Buffer, audio?:{name,buffer}, subtitle?:{name,buffer} }
export function makePipeline() {
  return async function pipeline(job, report) {
    const f = job.files;
    report('preparing', 0);
    if (f.zip) await prepareInput({ inputDir: job.inputDir, kind: 'zip', buffer: f.zip });
    else await prepareInput({ inputDir: job.inputDir, kind: 'html', buffer: f.html });

    let audioPath = null, subtitlePath = null;
    const fsp = await import('node:fs/promises');
    if (f.audio) { audioPath = path.join(job.inputDir, f.audio.name); await fsp.writeFile(audioPath, f.audio.buffer); }
    if (f.subtitle) { subtitlePath = path.join(job.inputDir, f.subtitle.name); await fsp.writeFile(subtitlePath, f.subtitle.buffer); }

    const srv = await startStaticServer(job.inputDir);
    const p = job.params;
    const enc = createEncoder({
      output: job.output, width: p.width, height: p.height, fps: p.fps,
      codec: p.codec, crf: p.crf, audioPath, subtitlePath, subtitleMode: p.subtitleMode,
    });
    // 若 ffmpeg 中途退出（非 0），中止渲染，避免向死管道写入而永久挂起。
    const controller = new AbortController();
    enc.proc.on('close', (code) => { if (code !== 0) controller.abort(); });

    const writeFrame = (buf) => {
      if (enc.stdin.write(buf)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          enc.stdin.off('drain', onDrain);
          controller.signal.removeEventListener('abort', onAbort);
        };
        const onDrain = () => { cleanup(); resolve(); };
        const onAbort = () => { cleanup(); reject(new Error('encoder aborted')); };
        enc.stdin.once('drain', onDrain);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    };

    try {
      await renderFrames({
        url: srv.url + '/index.html', width: p.width, height: p.height, fps: p.fps, durationSec: p.durationSec,
        signal: controller.signal,
        onFrame: async (buf) => { await writeFrame(buf); },
        onProgress: (done, total) => report('rendering', done / total),
      });
      enc.stdin.end();
      report('encoding', 0.99);
      await enc.done;
    } catch (e) {
      try { enc.stdin.destroy(); } catch (_) {}
      // 优先抛出 ffmpeg 的真实错误（若有），否则抛渲染错误。
      let ffErr = null;
      await enc.done.catch((err) => { ffErr = err; });
      throw ffErr || e;
    } finally {
      await srv.close();
    }
  };
}
