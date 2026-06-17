# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Web 工具：把自动播放的 HTML 页面**确定性逐帧**渲染成 MP4/WebM，支持外挂音频与字幕。Playwright(Chromium) 截帧 → PNG 管道 → FFmpeg 编码。ESM (`"type":"module"`)，Node 24+，依赖系统 FFmpeg/ffprobe 在 PATH。持久化用 node:sqlite（内置）。

## Commands

```bash
npm install
npx playwright install chromium        # 首次必跑，渲染依赖 Chromium
npm start                              # 127.0.0.1 + LAN IP；PORT=8080 npm start 改端口
npm test                              # 全套：node --test
node --test test/timeControl.test.js  # 单文件
node --test --test-timeout=120000 test/api.test.js   # 浏览器/ffmpeg 集成测试需长超时
```

需 Node 24+（node:sqlite 免 flag）。

测试用内置 `node --test` + `node:assert/strict`，无第三方测试框架。涉及浏览器/FFmpeg 的测试（renderer/pipeline/api/av/encoder）会真起 Chromium 与 ffmpeg 进程并用 ffprobe 校验产物——不是 mock，故慢且需 `--test-timeout`。

## Architecture

数据流（单机串行）：
```
HTTP 上传 → routes → store.insertJob(queued) → JobManager(串行队列) → pipeline → [assets → renderer → encoder]
                          │                                                              │
                          ├ SSE 进度推送                                                  ▼
                          └ 终态 → store.markDone/markFailed                    DATA_DIR/<id>/output.mp4|webm（持久）

历史/统计/下载：routes → store 查询 → 读 DATA_DIR 产物
```

各模块单一职责、接口清晰，`renderer` 产 PNG 帧流、`encoder` 消费帧流、`jobManager` 编排并报状态：

- **`src/timeControl.js`** — 注入页面的确定性虚拟时钟。覆写 `Date`/`performance.now`/`requestAnimationFrame`/`setTimeout`/`setInterval`，`window.__timeweb.goToTime(ms)` 把虚拟时钟推到某刻并触发到期回调。
- **`src/renderer.js`** — `renderFrames()`。启 Chromium，注入时钟，逐帧 `goToTime(i/fps*1000)` 后截 PNG，交给 `onFrame` 回调（带背压）。
- **`src/encoder.js`** — `createEncoder()`。spawn ffmpeg，stdin 收 PNG（`image2pipe`），滤镜 `scale=W:H[,subtitles][,format=yuv420p]`，可混音频/烧录或软字幕。返回 `{stdin, done, proc, setProgress}`。
- **`src/assets.js`** — 上传落盘、ZIP 解压（防 zip-slip）、起 127.0.0.1 随机端口静态服供渲染器加载相对资源。
- **`src/jobManager.js`** — 内存任务队列（并发 1）、状态机 `queued→preparing→rendering→encoding→done|failed`、每任务独立工作目录、进度事件。pipeline 可注入（便于测试）。
- **`src/pipeline.js`** — `makePipeline()` 把 assets→renderer→encoder 串起来，注入 JobManager。
- **`src/store.js`** — node:sqlite 持久层。projects/jobs 两表，CRUD + 按日期/按 project 聚合。注入 JobManager 与 routes，测试用 `:memory:`。
- **`src/routes.js`** — Fastify 路由：`POST /api/jobs`(multipart)、`GET /api/jobs/:id`(状态)、`/progress`(SSE)、`/video`(支持 Range)。
- **`server.js`** — `buildServer()` 工厂（不监听，便于测试）+ main 守卫监听。
- **`web/`** — 原生前端，无框架。

## 关键约束与陷阱（改前必读）

- **`installTimeControl` 必须自包含**：它经 `Function.prototype.toString()` 序列化后注入浏览器（`renderer.js` 的 `addInitScript`）。函数体内**禁止**引用任何外部变量/import/闭包符号，否则注入即失效。
- **逐帧下页面声音录不到**：时钟被冻结/加速，故音频只能由用户**单独上传**，FFmpeg 混入。页面内 `<video>`/实时音频不在捕获范围。
- **动画须由 rAF/定时器/Web Animations 驱动**：纯 CSS `animation` 经 `getAnimations().currentTime` 同步；不受控的实时动画无法确定性步进。
- **0 延迟 setTimeout 自链防死循环**：`fireDueTimers` 用 `eligible` 快照，只触发 drain 开始时已存在的定时器，回调中新建的延到下一帧。改时钟逻辑勿破坏此快照。
- **renderer 的 composite-wait 用 `page.waitForTimeout(0)`**：不能用页面 rAF 等合成（rAF 已被覆写，只由 goToTime 驱动，会挂起）。
- **ffmpeg 中途死亡的中止**：`pipeline.js` 用 AbortController，ffmpeg 非 0 退出时 abort 渲染并唤醒背压等待，避免向死管道写入永久挂起。catch 优先抛 ffmpeg 真实错误。
- **VP9 → `.webm` 容器**：`jobManager` 按 `params.codec` 决定输出扩展名（vp9→webm，否则 mp4）；`/video` 路由据扩展名设 content-type。
- **编码归一化**：encoder 始终套 `scale=W:H,format=yuv420p`，保证偶数尺寸与最大兼容；输入帧任意尺寸都可。
- **LAN 访问**：服务绑 `0.0.0.0`，启动时打印 127.0.0.1 与自动探测的 LAN IP。无鉴权/多租户/沙箱，勿按公网假设加复杂度。
- **产物持久在 `DATA_DIR`（默认 `./data`，env 可覆盖）**：不再用 tmpdir。`/video` 路由查 store 取产物路径，重启后历史仍可下载——勿改回依赖内存 Map。
- **project 必填**：`POST /api/jobs` 须带存在的 `projectId`，否则 400。`jobs.project_id NOT NULL`，删 project 级联删 jobs 行（产物文件由路由另删）。
- **保留策略**：产物不自动清理，仅手动删除接口。`RETENTION_MAX` 为预留 TODO，未实现自动清理——加自动清理前先确认需求。

## Specs / Plan

设计与实现计划在 `docs/superpowers/specs/` 与 `docs/superpowers/plans/`，记录了已确认的技术决策（捕获方式、音频/字幕来源、时长控制等），改动方向前可参考。
