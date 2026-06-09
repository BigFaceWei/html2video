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
    try {
      await renderFrames({
        url: srv.url + '/index.html', width: p.width, height: p.height, fps: p.fps, durationSec: p.durationSec,
        onFrame: async (buf) => { if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once('drain', r)); },
        onProgress: (done, total) => report('rendering', done / total),
      });
      enc.stdin.end();
      report('encoding', 0.99);
      await enc.done;
    } finally {
      await srv.close();
    }
  };
}
