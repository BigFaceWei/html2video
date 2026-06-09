# html2video

把自动播放的 HTML 页面**确定性逐帧**渲染成 MP4 / WebM，支持外挂音频与字幕。Playwright(Chromium) 截帧 → PNG 管道 → FFmpeg 编码。

每次转换都会留存记录、绑定到一个 project，可回看历史、下载产物，并查看统计图表。

## 功能

- **确定性逐帧渲染**：注入虚拟时钟，逐帧推进后截图，输出与实时无关、可复现。
- **多编码 / 容器**：H.264 / H.265 → MP4，VP9 → WebM；可调分辨率、帧率、时长、CRF。
- **外挂音频与字幕**：单独上传音频混入；字幕支持烧录（硬字幕）或软字幕。
- **转换历史 + Project 分组**：每次转换绑定一个 project（必选），记录持久化，服务重启后历史视频仍可下载。
- **下载**：单个视频下载，或按 project 打包成 zip 下载。
- **统计图表**：按日期（成功 / 失败）、按 project（转换数）、编码分布。

## 依赖

- Node.js **24+**（持久化用内置 `node:sqlite`，免 flag）
- 系统安装 FFmpeg / ffprobe（PATH 可用）

## 安装

```bash
npm install
npx playwright install chromium   # 首次必跑
```

## 运行

```bash
npm start                    # http://127.0.0.1:3000
PORT=8080 npm start          # 指定端口
DATA_DIR=/path/to/data npm start   # 指定数据目录（默认 ./data）
```

数据（sqlite 库与视频产物）存放在 `DATA_DIR`（默认项目下 `./data`，已加入 `.gitignore`）。产物不会自动清理，可通过界面手动删除。

## 测试

```bash
npm test                                            # 全套
node --test test/store.test.js                      # 存储层单测（快）
node --test --test-timeout=120000 test/api.test.js  # 集成测试（起 Chromium/ffmpeg，需长超时）
```

## 使用

浏览器打开页面 → 选择或新建一个 **project** → 上传单个 `.html` 或含 `index.html` 的 `.zip` → 设分辨率 / 帧率 / 时长 / 编码 / CRF → 可选上传音频与字幕（烧录或软字幕）→ 开始转换 → 进度完成后预览并下载。

下方「历史」区可按 project 筛选、下载或删除单条记录、打包下载整个 project；「统计」区展示按日期与按 project 的图表。

## 限制

- 动画须由 requestAnimationFrame / 定时器 / Web Animations 驱动；页面内 `<video>` / 实时音频不在逐帧捕获范围。
- 音频请单独上传，自行对齐起始时间。
- 时长为用户指定的固定值。
- 本地单机定位：仅绑定 `127.0.0.1`，无鉴权 / 多租户 / 沙箱。
