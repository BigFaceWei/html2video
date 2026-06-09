import { chromium } from 'playwright';
import { installTimeControl } from './timeControl.js';

// opts: { url, width, height, fps, durationSec, onFrame(buf,index), onProgress?(done,total), signal? }
export async function renderFrames(opts) {
  const { url, width, height, fps, durationSec, onFrame, onProgress, signal } = opts;
  const totalFrames = Math.max(1, Math.ceil(durationSec * fps));

  const browser = await chromium.launch({ args: ['--disable-gpu', '--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    // 注入虚拟时钟（toString 序列化，自包含函数）
    await page.addInitScript(`(${installTimeControl.toString()})(window);`);
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts && document.fonts.ready);

    for (let i = 0; i < totalFrames; i++) {
      if (signal && signal.aborted) throw new Error('canceled');
      const t = (i / fps) * 1000;
      await page.evaluate((ms) => window.__timeweb.goToTime(ms), t);
      // 等一次真实合成，确保像素落地。
      // 注意：installTimeControl 覆盖后页面的 requestAnimationFrame 只由 goToTime 驱动，
      // 真实合成不再自动触发页面 rAF，所以不能用 page rAF 等待（会挂起）。
      // 改用 Playwright 的真实时钟等待，让浏览器完成一次真实合成后再截图。
      await page.waitForTimeout(0);
      const buf = await Promise.race([
        page.screenshot({ type: 'png' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timeout')), 30000)),
      ]);
      await onFrame(buf, i);
      if (onProgress) onProgress(i + 1, totalFrames);
    }
  } finally {
    await browser.close();
  }
}
