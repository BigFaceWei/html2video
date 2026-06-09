# HTML → MP4 转换器 · 架构设计文档

- 日期：2026-06-09
- 状态：已与需求方确认核心决策，待文档最终评审

## 1. 项目目标

把一个**自动播放**的 HTML 页面（CSS / Canvas / JS 动画）转换成 MP4 视频。提供 Web 界面：用户上传 HTML、设置参数、点击转换、实时看进度、转换完成后在线预览并下载。支持外挂音频与字幕。

### 1.1 范围内（In Scope）

- 确定性逐帧渲染，输出固定帧率、固定时长的视频。
- Web 上传 + 参数设置 + 进度展示 + 在线预览 + 下载。
- 单文件自包含 HTML 与 ZIP 资源包两种输入。
- 用户单独上传的音频文件混入视频。
- 用户上传 srt/vtt 字幕，支持「烧录（硬字幕）」与「软字幕（内嵌轨道）」二选一。

### 1.2 范围外（Out of Scope，本期不做）

- 多用户鉴权、配额、公网安全沙箱（本期定位**本地单机工具**）。
- 从 HTML 页面里自动提取/录制音频。
- 页面信号（`window.__done()`）驱动的变长时长（本期用固定时长）。
- 分布式 / 多机渲染。

## 2. 核心技术决策（已确认）

| 维度 | 决策 | 理由 |
|---|---|---|
| 捕获方式 | **确定性逐帧**：劫持页面时间 API，逐帧推进虚拟时钟后截图 | 帧率与渲染速度解耦，慢机器也能稳定输出 60fps，画质上限最高 |
| 帧传输 | 截图 **PNG buffer 经管道喂入 FFmpeg stdin**（`image2pipe`），不落盘 | 避免成千上万临时文件，省 IO，吞吐高 |
| 音频来源 | **用户单独上传音频文件**，FFmpeg 混入 | 逐帧捕获下页面声音无法实时录制；解耦最简单可靠 |
| 字幕 | 用户上传 srt/vtt，**烧录 / 软字幕**二选一 | 兼顾「任意播放器可见」与「可开关」两类需求 |
| 时长 | **用户设固定秒数**，总帧数 = 时长 × 帧率 | 可预测、实现最简单 |
| 视频编码 | **H.264 / libx264**（默认），可选 H.265 / VP9 | 兼容性最佳 |
| 部署 | **本地单机工具**，内存任务队列 | 单人使用，无需多租户/鉴权 |
| HTML 输入 | **单自包含 HTML + ZIP 包**都支持 | 覆盖简单与复杂项目 |
| 进度推送 | **SSE（Server-Sent Events）** | 单向推进度，比 WebSocket 简单 |
| 技术栈 | Node.js + Fastify + Playwright(Chromium) + FFmpeg + 原生前端 | — |

## 3. 整体架构

```
┌─────────────┐   上传/参数    ┌──────────────────────────────────┐
│  浏览器前端  │ ─────────────► │           Fastify API 层          │
│ (上传/进度/  │ ◄── SSE 进度 ── │  上传 / 起任务 / 进度 / 下载 / 静态  │
│  预览/下载)  │ ◄── 预览/下载 ─ └───────────────┬──────────────────┘
└─────────────┘                                │
                                       ┌────────▼─────────┐
                                       │   jobManager     │ 队列 + 状态机
                                       └────────┬─────────┘
                            ┌───────────────────┼───────────────────┐
                     ┌──────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
                     │   assets    │     │  renderer   │ PNG │   encoder   │
                     │ 解压/静态服  │     │ Playwright  │ ──► │   FFmpeg    │
                     └─────────────┘     │ +时间劫持   │ 流  │ 编码+混音+字幕│
                                         └─────────────┘     └──────┬──────┘
                                                                    ▼
                                                              output.mp4
```

## 4. 组件划分

每个组件单一职责、接口清晰；`renderer` 产帧流，`encoder` 消费帧流，`jobManager` 编排并报状态。

### 4.1 `web/`（前端）
- 纯静态页面（HTML + JS，无框架）。
- 上传表单：HTML/ZIP（必）、音频（选）、字幕（选）。
- 参数表单：分辨率、帧率、时长、编码、CRF、字幕模式。
- 进度条：监听 `EventSource` SSE。
- 完成后：`<video>` 预览 + 下载按钮。

### 4.2 `server.js`（API 层，Fastify）
路由：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/jobs` | multipart 上传文件 + 参数，创建任务，返回 `jobId` |
| `GET` | `/api/jobs/:id/progress` | SSE 进度流（阶段、百分比、当前帧、错误） |
| `GET` | `/api/jobs/:id/video` | 下载/预览 `output.mp4`（支持 Range，便于预览拖动） |
| `GET` | `/api/jobs/:id` | 查任务状态（SSE 断线后兜底轮询） |
| `GET` | `/` | 前端静态资源 |

### 4.3 `jobManager.js`
- 内存任务表 `Map<jobId, Job>`。
- 队列：并发上限默认 1（串行，可配），超出排队。
- 状态机：`queued → preparing → rendering → encoding → done | failed | canceled`。
- 每任务独立工作目录；结束后按策略清理。
- 接口：`createJob(params, files) → jobId`、`getJob(id)`、`onProgress(id, cb)`、`cancel(id)`。

### 4.4 `assets.js`
- 校验上传：MIME/扩展名白名单、大小上限。
- ZIP：解压到 `work/<id>/input/`，防 **zip-slip**（拒绝 `..` / 绝对路径），要求含 `index.html`。
- 单 HTML：写入 `input/index.html`。
- 起一个**本地静态服务**（绑定 127.0.0.1 随机端口）指向 `input/`，渲染器用 `http://127.0.0.1:<port>/index.html` 加载，保证相对资源（CSS/JS/图片/字体）正常解析。

### 4.5 `renderer.js`（Playwright）
- 启 Chromium（headless，`--disable-gpu` 视情况）。
- 设 viewport = 目标分辨率，`deviceScaleFactor=1`。
- `addInitScript` 注入 `timeControl.js`，在页面任何脚本执行前覆写时间 API。
- 导航到本地静态 URL，等 `load` + 字体/资源就绪。
- 逐帧循环：
  1. 调页面内驱动函数把虚拟时钟设到 `t = frameIndex / fps * 1000` ms。
  2. 触发到期的 `requestAnimationFrame` / `setTimeout` / `setInterval` 回调。
  3. 等一次真实合成（`requestAnimationFrame` flush / 短等待）。
  4. `page.screenshot({type:'png'})` 得到 buffer。
  5. 把 buffer `write` 进 encoder 的 stdin；背压时 `await drain`。
- 产出 `totalFrames = ceil(duration * fps)`，每帧回报进度。
- 接口：`render(job, frameSink) → Promise<void>`。

### 4.6 `timeControl.js`（注入页面，浏览器内运行）
劫持，建立确定性虚拟时钟：

- 覆写 `Date`、`Date.now`、`performance.now` → 返回虚拟时间。
- 覆写 `requestAnimationFrame` / `cancelAnimationFrame` → 回调入队，由驱动按虚拟时刻触发。
- 覆写 `setTimeout` / `setInterval` / `clearTimeout` / `clearInterval` → 入队，按虚拟到期时刻触发。
- 暴露驱动 API（挂 `window.__timeweb`）：`goToTime(ms)`：把虚拟时钟推进到 `ms`，依次触发区间内到期的定时器与 rAF 回调。
- 原理参考开源 `timesnap`/`timeweb`（puppeteer 系），本项目用 Playwright 重新实现并简化为固定帧步进。

### 4.7 `encoder.js`（FFmpeg）
- 以 `image2pipe` 从 stdin 读 PNG 帧序列：`-f image2pipe -framerate <fps> -i pipe:0`。
- 可选第二输入：音频文件。
- 字幕：
  - 烧录 → 视频滤镜 `-vf subtitles=<file>`（注意 yuv420p 与滤镜顺序）。
  - 软字幕 → 额外输入 + `-c:s mov_text`（mp4）映射。
- 编码：`-c:v libx264 -crf <crf> -pix_fmt yuv420p -r <fps>`（H.265→`libx265`，VP9→`libvpx-vp9`+webm）。
- 音频：`-c:a aac -shortest`。
- 解析 FFmpeg `stderr`（`frame=` 行）或以渲染帧计数推百分比。
- 接口：`createEncoder(params) → { stdin, done: Promise, onProgress }`。

## 5. 数据流（端到端）

```
1. 前端 POST /api/jobs（multipart：html/zip + 可选 audio + 可选 subtitle + 参数 JSON）
2. server 收文件 → jobManager.createJob → 建 work/<id>/input/，返回 jobId
3. 前端打开 EventSource /api/jobs/<id>/progress
4. jobManager 出队执行：
   a. assets：解压/落盘 + 起本地静态服
   b. encoder：拼好 FFmpeg 命令，拿到 stdin 与 done Promise
   c. renderer：逐帧截图 → 写入 encoder.stdin（带背压）
   d. 全部帧写完 → 关 stdin → 等 FFmpeg 退出 → output.mp4
   e. ffprobe 校验帧数/时长/轨道
5. 进度阶段经 SSE 推：preparing → rendering(帧%) → encoding → done
6. 前端 done：<video src="/api/jobs/<id>/video"> 预览 + 下载
7. 清理：关静态服、删 input/（保留 output.mp4 供下载，按 TTL 或手动清）
```

## 6. 编码参数（前端可设）

| 参数 | 选项 / 默认 |
|---|---|
| 分辨率 | 预设 1920×1080 / 1280×720 / 1080×1920(竖) / 自定义；默认 **1920×1080** |
| 帧率 | 24 / 30 / 60；默认 **30** |
| 时长 | 秒数，**必填** |
| 视频编码 | **H.264(libx264)** / H.265(libx265) / VP9；默认 H.264 |
| 质量 | CRF 0–51，默认 **20**（越小越清晰）；可选目标码率模式 |
| 容器 | mp4（H.264/265）/ webm（VP9），按编码自动 |
| 像素格式 | **yuv420p**（强制，保最大兼容） |
| 音频 | 可选上传 mp3/aac/wav → `-c:a aac` 混入 |
| 字幕 | 可选上传 srt/vtt + 选「烧录」或「软字幕」 |

## 7. 错误处理

- **上传校验**：类型/大小白名单；ZIP 防 zip-slip；ZIP 必须含 `index.html`。
- **渲染超时**：单任务总时长上限 + 单帧截图超时；卡住 kill Chromium。
- **FFmpeg 失败**：捕获 stderr 原文回传前端展示。
- **进程清理**：结束/失败/取消都清工作目录、杀残留 Chromium/FFmpeg 子进程。
- **SSE 断线**：前端可重连，并以 `GET /api/jobs/:id` 兜底轮询状态。
- **帧数校验**：渲完用 `ffprobe` 核对输出帧数/时长是否匹配 `时长×帧率`。
- **背压**：renderer 写 stdin 遇 `false` 时 `await drain`，防内存爆。

## 8. 测试策略

- **单元**：`timeControl.js` 虚拟时钟——rAF/setTimeout/setInterval 在正确虚拟时刻、正确顺序触发；`goToTime` 跨多个到期点。
- **集成**：内置小 HTML（CSS 动画）→ 渲 2 秒 mp4，`ffprobe` 断言分辨率/帧率/时长/像素格式；带音频断言音轨；带字幕断言烧录像素变化 / 软字幕轨道存在。
- **边界**：ZIP 正常解压、缺 `index.html`、zip-slip 被拒、坏 srt、超时被 kill、FFmpeg 报错透传。

## 9. 工作目录结构

```
html2video/
├── server.js
├── src/
│   ├── jobManager.js
│   ├── assets.js
│   ├── renderer.js
│   ├── timeControl.js      # 注入浏览器
│   └── encoder.js
├── web/                    # 前端静态资源
│   ├── index.html
│   └── app.js
├── work/<jobId>/
│   ├── input/              # html/zip解压/audio/subtitle
│   └── output.mp4          # 成品
├── test/
└── docs/superpowers/specs/2026-06-09-html2video-design.md
```

## 10. 关键风险与缓解

| 风险 | 缓解 |
|---|---|
| 页面动画非 rAF/定时器驱动（如 CSS `animation` 自走、`<video>` 标签） | CSS 动画可经 `document.getAnimations()` 同步 `currentTime`；`<video>` 标签本期不保证（文档注明） |
| 截图吞吐成为瓶颈（大分辨率 × 高帧率） | PNG 管道 + 背压；后续可评估 CDP screencast 加速 |
| 字体/资源未加载完就截首帧 | 导航后等 `document.fonts.ready` + 资源 idle |
| 长视频内存/磁盘 | 流式管道不落盘帧；output 设大小上限提示 |

## 11. 里程碑（供后续实现计划拆分）

1. 骨架：Fastify + 上传 + 任务队列 + 工作目录。
2. 渲染：`timeControl.js` + `renderer.js`，逐帧 PNG（先落盘验证正确性）。
3. 编码：`encoder.js` PNG 管道 → mp4，ffprobe 校验。
4. 打通：SSE 进度 + 前端上传/进度/预览/下载。
5. 音频 + 字幕（烧录/软）。
6. ZIP 支持 + 静态服 + 安全校验。
7. 错误处理、超时、清理、测试补齐。
