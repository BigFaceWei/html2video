import { spawn } from 'node:child_process';

const VCODEC = { h264: 'libx264', h265: 'libx265', vp9: 'libvpx-vp9' };

// opts: { output, width, height, fps, codec, crf, audioPath?, subtitlePath?, subtitleMode? ('burn'|'soft') }
export function createEncoder(opts) {
  const { output, width, height, fps, codec = 'h264', crf = 20,
          audioPath = null, subtitlePath = null, subtitleMode = 'burn' } = opts;

  let vf = `scale=${width}:${height}`;
  if (subtitlePath && subtitleMode === 'burn') {
    const esc = subtitlePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
    vf += `,subtitles='${esc}'`;
  }
  vf += ',format=yuv420p';

  const args = ['-y', '-f', 'image2pipe', '-r', String(fps), '-i', 'pipe:0'];
  if (audioPath) args.push('-i', audioPath);
  if (subtitlePath && subtitleMode === 'soft') args.push('-i', subtitlePath);

  args.push('-vf', vf, '-r', String(fps), '-c:v', VCODEC[codec] || 'libx264', '-crf', String(crf));
  if (audioPath) args.push('-c:a', 'aac', '-shortest');
  if (subtitlePath && subtitleMode === 'soft') args.push('-c:s', 'mov_text');
  // 显式映射，避免输入序号混乱
  args.push('-map', '0:v:0');
  if (audioPath) args.push('-map', '1:a:0');
  if (subtitlePath && subtitleMode === 'soft') args.push('-map', `${audioPath ? 2 : 1}:s:0`);
  args.push(output);

  const proc = spawn('ffmpeg', args);
  let stderr = '';
  const onProgress = { fn: null };
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    const m = /frame=\s*(\d+)/.exec(d.toString());
    if (m && onProgress.fn) onProgress.fn(Number(m[1]));
  });

  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${stderr.slice(-2000)}`)));
  });
  // 防止 stdin EPIPE 在错误时抛未捕获
  proc.stdin.on('error', () => {});

  return { stdin: proc.stdin, done, proc, setProgress(fn) { onProgress.fn = fn; } };
}
