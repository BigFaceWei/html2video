# 转换历史 + Project 分组 + 统计图表 设计

日期：2026-06-09
状态：已确认（待实现）

## 背景与目标

当前 html2video 把任务全放内存（`JobManager.jobs` Map），产物写在 `os.tmpdir()/html2video-work/<id>/output.ext`。服务重启即丢全部任务元数据，`/video` 路由依赖内存 `jm.get(id)`，重启后即便产物文件还在也返回 404；OS 也会清理 tmp。系统没有 project 概念，无法回看历史。

本设计为系统增加持久化能力，使每一次转换都留存记录、绑定到一个 project，并支持：

- 单个历史视频下载（重启后仍可下）；
- 按 project 打包下载全部产物；
- 按日期、按 project 的统计图表。

核心约束：渲染/编码管线（timeControl、renderer、encoder、pipeline）完全不触碰，改动纯加性。

## 已确认的关键决策

1. **存储**：`node:sqlite` 内置模块（无原生依赖）。Node 基线由 20 抬到 **24+**（当前环境 v24.15.0，`node:sqlite` 免 flag、`DatabaseSync` 可用）。放弃二进制打包兼容目标。
2. **存储位置**：`./data`，可由 env `DATA_DIR` 覆盖。sqlite 库 `./data/html2video.db`，产物 `./data/<jobId>/output.ext`。`data/` 加入 `.gitignore`。
3. **保留策略**：不自动清理，仅提供手动删除接口。保留上限留 TODO 与 `RETENTION_MAX` 配置位，本期不实现。
4. **project 绑定**：必填。提交转换时选已有 project 或新建，`jobs.project_id NOT NULL`。
5. **失败任务**：入库（status=failed，无产物），用于统计成功率与排查。
6. **统计维度**：按日期、按 project 两类图表。
7. **前端**：单页分区（转换 / 历史 / 统计），原生无框架，图表用 Chart.js 本地引入、无构建。打包下载用已有依赖 adm-zip。
8. **存储层接入方式**：独立 `src/store.js` 模块，注入 `JobManager` 与 routes（与现有「模块单一职责、pipeline 可注入」风格一致）。

## 数据模型

```sql
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,         -- uuid
  name       TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL          -- epoch ms
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,       -- uuid（沿用现 job id）
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,          -- queued | done | failed
  params       TEXT NOT NULL,          -- JSON: width,height,fps,durationSec,codec,crf,subtitleMode
  source_name  TEXT,                   -- 上传源文件名
  output_ext   TEXT,                   -- mp4 | webm
  size_bytes   INTEGER,                -- done 时回填
  has_audio    INTEGER NOT NULL DEFAULT 0,
  has_subtitle INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   INTEGER NOT NULL,
  finished_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
```

PRAGMA：`journal_mode=WAL`、`foreign_keys=ON`。建表用 `CREATE TABLE IF NOT EXISTS`，作为一次性迁移。

产物的磁盘路径不入库——由 `DATA_DIR/<jobId>/output.<output_ext>` 推导，避免存绝对路径导致目录迁移即失效。

## 组件设计

### `src/store.js`（新增，单一职责）

`createStore(dbPath)` 返回同步 API（并发 1，无锁竞争）：

```
projects:
  createProject(name)            // name 唯一；已存在返回现有行（幂等）
  listProjects()                 // → [{...project, jobCount, doneCount}]
  getProject(id)
  deleteProject(id)              // 级联删 jobs 行；产物文件由调用方删

jobs:
  insertJob({id, project_id, params, source_name, output_ext, has_audio, has_subtitle})  // status=queued
  markDone(id, {size_bytes})     // status=done, finished_at=now
  markFailed(id, error)          // status=failed, finished_at=now
  getJob(id)
  listJobs({project_id?, limit, offset})

stats:
  statsByDate({from?, to?})      // → [{day, total, done, failed, bytes}]，day 为 YYYY-MM-DD
  statsByProject()               // → [{project_id, name, total, done, failed, bytes, codecBreakdown}]
                                 //   codecBreakdown: {h264, h265, vp9}
```

全部 prepared statements。日期分组用 SQLite `strftime('%Y-%m-%d', created_at/1000, 'unixepoch')`。测试用 `:memory:` 注入。

### `src/jobManager.js`（改动）

- 构造签名加 store：`new JobManager({ baseDir, pipeline, store })`。
- `create(params, files, projectId)`：生成 id 后**立即** `store.insertJob(...)`（status=queued，记录 source_name、output_ext、has_audio、has_subtitle），再入队。这样失败任务也已落盘、历史可见。
- `_drain` 成功分支：删 inputDir 后 `fs.stat(output)` 取 size，`store.markDone(id, {size_bytes})`。
- `_drain` 失败分支：删整个 job 目录后 `store.markFailed(id, error)`。
- 进度（SSE）高频，不入库，仅终态写一次。
- 内存 Map 仍保留，作为「进行中任务」的实时进度源；历史查询一律走 store。

### `src/routes.js`（改动 + 新增）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| POST | `/api/projects` | body `{name}` → `store.createProject`，返回 project |
| GET | `/api/projects` | `store.listProjects` |
| POST | `/api/jobs` | multipart，**projectId 必填**且须存在（否则 400），其余字段不变 |
| GET | `/api/jobs?project=&limit=&offset=` | `store.listJobs` |
| GET | `/api/jobs/:id` | 内存优先；落空查 store（历史详情） |
| GET | `/api/jobs/:id/video` | **查 store 取 output 路径与 ext**，文件存在即可下；Range 逻辑不变 |
| DELETE | `/api/jobs/:id` | `store.deleteJob` + `fs.rm` 产物目录 |
| GET | `/api/projects/:id/download` | adm-zip 流式打包该 project 全部 done 产物 |
| DELETE | `/api/projects/:id` | `store.deleteProject`（级联）+ 逐个 `fs.rm` 产物目录 |
| GET | `/api/stats?by=date` | `store.statsByDate` |
| GET | `/api/stats?by=project` | `store.statsByProject` |

关键改动：

- **BASE**：`os.tmpdir()/html2video-work` → `DATA_DIR`（env，默认 `./data`）；启动时建库与目录。
- **`/video` 解耦内存**：改为查 store 取产物路径，不再依赖 `jm.get` 内存对象——这是「重启后历史视频仍可下载」的关键。
- **`POST /api/jobs` 校验**：projectId 必填且存在，否则 400。

### `web/`（前端，原生无框架，单页分区）

单页三区，锚点或 show/hide 切换，无路由：

1. **转换区**：现有表单顶部加 project 下拉（`GET /api/projects` 填充）+「+ 新建」内联输入；提交必带 projectId。进度/预览/下载逻辑保留。
2. **历史区**：project 过滤下拉；列表渲染 `GET /api/jobs?project=`，每行显示时间、project、编码、尺寸/帧率、状态色标、体积、操作（预览 / 下载 / 删除）；选中某 project 时显「打包下载本 project」按钮。
3. **统计区**（Chart.js）：
   - 按日期：折线——每日转换数 + 成功/失败堆叠；每日总体积。
   - 按 project：柱（各 project 转换数）+ 饼（编码占比）+ 成功率。

`app.js` 现单文件将膨胀，拆为 `app.js`（转换）、`history.js`、`stats.js`，共用 `common.js`（`$`、fetch 封装），各管一区。

## 数据流（更新后）

```
HTTP 上传 → routes → store.insertJob(queued) → JobManager(串行队列) → pipeline → [assets → renderer → encoder]
                                    │                                                          │
                                    ├─ SSE 进度推送                                            ▼
                                    └─ 终态 → store.markDone/markFailed              ./data/<id>/output.ext (持久)

历史/统计/下载：routes → store 查询 → 读 ./data 产物
```

## 错误处理

- projectId 缺失或不存在 → 400。
- 删除不存在的 job/project → 404。
- `/video`：store 无记录或产物文件缺失 → 404。
- 打包下载时个别产物文件缺失 → 跳过该文件，不整体失败（日志记录）。
- store 写失败不应中断渲染管线已产出的产物；终态写入包裹 try/catch，失败仅记日志。

## 测试策略

沿用 `node --test` + `node:assert/strict`，无三方框架。

- **`test/store.test.js`（新增）**：`:memory:` 库，纯单测——project 名唯一与幂等、级联删除、job 增改查、`statsByDate`/`statsByProject` 数值正确（含 codecBreakdown）。快，不起浏览器/ffmpeg。
- **`test/api.test.js`（扩展）**：projectId 必填校验、历史列表、`/video` 在「新建 JobManager 复用同一 store」下仍可下载（模拟重启）、删除接口、stats 接口返回形状。
- 渲染/编码相关测试零改动。

## 文档同步

- `CLAUDE.md`：数据流图加持久层节点；Node 基线 20 → 24；新增接口段落；`./data`、`DATA_DIR`、保留策略说明。
- `.gitignore` 加 `data/`。

## 范围外（YAGNI / TODO）

- 自动保留上限/配额清理（预留 `RETENTION_MAX` 配置位，不实现）。
- 鉴权 / 多租户（本地单机定位不变）。
- project 重命名、产物去重、缩略图。
```
