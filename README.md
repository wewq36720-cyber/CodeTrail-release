# CodeTrail 码途 —— 本地代码学习平台

> 一个运行在本机浏览器的学习平台：选定目录自动扫描学习项目，生成学习路线，在内置 IDE 阅读区读代码、
> 问 AI、跑测试、记进度，多课程并行、全局看板汇总。**数据全在本机，学习仓库只读，不配 AI Key 也完整可用。**

![版本](https://img.shields.io/badge/Node.js-20%2B-339933)
![前后端](https://img.shields.io/badge/Stack-React%20%2B%20Express%20%2B%20node%3Asqlite-66bb6a)
![浏览器](https://img.shields.io/badge/Browser-127.0.0.1%3A8787-ffffff)

## 截图

| 工作台 · 学习路线图 | 看板 · 跨课程汇总 | AI 助手 · 学习现场 |
|---|---|---|
| ![工作台](screenshots/overview.png) | ![看板](screenshots/dashboard.png) | ![AI 助手](screenshots/ai-assistant.png) |
| **路线弹窗 · 智能路线/导入/AI 草案** | **设置 · 根路径与主题** | **AI 设置** |
| ![路线](screenshots/routes.png) | ![设置](screenshots/settings.png) | ![AI 设置](screenshots/settings-ai.png) |

## 特性

- **自动扫描课程**：登记任意学习目录，自动识别源码仓库 / 教程文档 / 示例，分类成课程
- **代码索引驱动**：符号提取（Python AST / JS·Go 正则）→ 内部依赖图 → PageRank 重要度排序 → 角色判定（核心/入口/示例/文档/测试），零 Token 本地生成
- **学习路线**：智能路线（入口 → 核心文件带行区间与理由 → 示例）、Markdown 指南导入、AI 草案三来源；步骤编辑器 + 文件存在性校验
- **内置 IDE 阅读区**：Monaco 编辑器、三栏可拖拽、符号大纲、书签（行号槽点击）、大文件切片读、md 渲染/源码切换
- **AI 助手**：多会话、上下文芯片自动携带课程/步骤/文件，支持讲解/问答/路线生成/教程翻译（仅非代码内容按需译）
- **测试闯关与静态检查**：M1 输出比对 / M2 断言脚本，沙箱执行；py_compile / node --check / go vet；WS 流式日志
- **进度与复习**：状态机 + 1~5 自评；低分自动进复习队列，7 天到期复习提醒；看板 + 30 天像素热力
- **五套主题**：奶油深绿（默认）/ 浅绿纸 / 墨夜亮绿 / 燕麦榜单 / 白纸蓝调，全部语义令牌、零硬编码色值
- **备份迁移**：一键导出 zip（进度 + 路线 + 测试 + 笔记，不含 AI Key），导入前自动保留原库快照

## 快速开始

### 本机启动（推荐）

双击 `start.bat`（自动检测 node/uv/go → 首次自动安装依赖并构建前端 → 单端口启动），
浏览器打开 <http://127.0.0.1:8787>。

### 手动方式

```bash
cd client && npm install && npm run build   # 首次
cd ../server && npm install
npm run dev                                  # http://127.0.0.1:8787
```

### Docker 生产形态

```bash
docker compose up --build -d
docker compose ps                 # 等待 codetrail 显示 healthy
```

浏览器打开 <http://127.0.0.1:8787>。Compose 将平台数据保存在 `codetrail-ldd` 命名卷，把上级学习目录以只读方式挂载为 `/workspace`；
首次启动后在「设置 → 学习根路径」添加 `/workspace`。镜像不包含 `.learndesk`、依赖缓存或 API Key，AI 配置只保存在该数据卷中。

### 首次使用

1. 打开后进入 **设置** → 添加学习根路径（如 `D:\Study`）→ 重新扫描
2. 课程胶囊选择课程 → 顶栏「路线」→ ⚡ 智能路线生成学习路线图
3. 点路线图叶片 → AI 界面：编辑器已定位到文件与行区间 → 读代码、问 AI、跑测试、记进度

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 · TypeScript · Vite · Monaco Editor · react-markdown |
| 后端 | Express · ws · node:sqlite（Node ≥ 22.5）· tsx |
| 代码索引 | 自研（AST 符号提取 + 依赖图 + PageRank） |
| 测试执行 | Python (uv) / Node / Go 工具链，沙箱重定向 |
| 容器 | Dockerfile + docker-compose（命名卷持久化） |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INTRO.md](docs/INTRO.md) | 项目简介（背景 / 定位 / 能力 / 边界） |
| [docs/FEATURES.md](docs/FEATURES.md) | 功能介绍（界面地图 / 核心机制 / FR 追溯） |
| [docs/API.md](docs/API.md) | 后端接口说明 |
| [DESIGN.md](DESIGN.md) | UI 设计契约（令牌 / 布局 / 状态） |

## 数据与安全边界

- **平台数据目录（LDD）**：`<工作区根>\.learndesk\`（可用 `LEARNDESK_DIR` 环境变量覆盖）——进度
  db.sqlite、settings.json（含 AI Key，勿提交/同步）、routes/、tests/、notes/、backups/、tmp/。
  **删除该目录即清除全部平台数据**。
- **学习仓库只读**：平台绝不写入学习者仓库（测试执行的临时文件/字节码全部重定向到 LDD/tmp）。
- 服务仅绑定 `127.0.0.1:8787`；文件访问白名单校验；执行进程 30s 超时 + 输出 200KB 截断。
- AI Key 仅存本机 settings.json，API 回传脱敏，不随备份导出。

## 验证

```bash
cd server && npm install
node --import tsx --test test/*.test.ts   # 后端单元/集成测试
cd ../client && npm install && npm run build   # 前端可构建
```

## 常见问题

- **页面打开但点了没反应**：多半是浏览器缓存了旧版页面，按 `Ctrl+F5` 强制刷新一次即可。
- **顶部出现红色「后端服务未连接」横幅**：后端没在运行。运行 `start.bat`，等它提示「服务已就绪」后再刷新页面。
- **提示端口 8787 被占用**：说明已有一个实例在运行，直接访问 <http://127.0.0.1:8787> 即可。
- **文件打不开 / 扫描为空**：确认根路径设置正确（设置 → 根路径 → 重新扫描）。

## License

MIT License（请按需替换为你的 LICENSE 文件）。