# html2video

把自动播放的 HTML 渲染成 MP4。Playwright 确定性逐帧 + FFmpeg 编码。

## 依赖
- Node.js 20+
- 系统安装 FFmpeg / ffprobe（PATH 可用）

## 安装
```bash
npm install
npx playwright install chromium
```

## 运行
```bash
npm start            # http://127.0.0.1:3000
PORT=8080 npm start  # 指定端口
```

## 测试
```bash
npm test
```

## 使用
浏览器打开页面 → 上传单个 .html 或含 index.html 的 .zip → 设分辨率/帧率/时长/编码/CRF → 可选上传音频与字幕（烧录或软字幕）→ 开始转换 → 进度完成后预览并下载。

## 限制
- 动画须由 requestAnimationFrame / 定时器 / Web Animations 驱动；页面内 `<video>` / 实时音频不在逐帧捕获范围。
- 音频请单独上传，自行对齐起始时间。
- 时长为用户指定的固定值。
