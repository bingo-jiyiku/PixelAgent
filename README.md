# PixelAgent

仿 95 复古像素终端风的桌面 AI Agent：**Electron 做界面，`pi` 做大脑**。
布局与操作学 opencode 桌面端（左会话 / 中时间线 / 右上下文面板），
皮肤是 Win95 + 像素风的黑粗边 + 硬阴影 + 点阵底。

## 用法

```bash
npm start           # 打开窗口
npm run test:pi     # Pi 接线单测（真调一次 pi，验流式 + 多轮）
npm run shot        # 开窗截图：待机 + 对话后（shots/01,02）
npm run shot:extra  # 补拍：FILES / TOOLS / 历史回放 / 命令面板（shots/03~07）
npm run verify:tools# 用真实事件流回放，验收右栏 TOOLS（shots/08）
```

## 布局（opencode 式三栏）

```
┌ topbar  PIXELAGENT v1.0 · SESSION #n ·················· [—][□][✕]
├────────────┬──────────────────────────────┬───────────────────┤
│ SESSIONS   │  TIMELINE                    │ TOOLS/TODOS/      │
│ 会话列表    │  空态：大标题 + 像素女孩      │ FILES/AGENTS      │
│ + NEW      │  有消息：消息流              │ 四个 tab 面板      │
├────────────┴──────────────────────────────┴───────────────────┤
│ › 输入框（/ 命令 · @ 文件）              [SEND] [■ STOP]      │
│ IDLE │ 轮次 │ 用时 │ 模型 │ 快捷键提示 │ 时钟 │ ⚙            │
└──────────────────────────────────────────────────────────────┘
```

### 操作

| 动作 | 怎么用 |
| --- | --- |
| 发送 | 输入框回车 或 点 `SEND` |
| 打断 | `ESC` 或 点 `■ STOP` |
| 新会话 | 左栏 `+ NEW` 或 `Ctrl+N` |
| 切历史会话 | 点左栏任一条（会回放该会话的消息，上下文延续） |
| 命令面板 | 输入框打 `/`（上下选、回车执行） |
| 引用文件 | 输入框打 `@`（候选来自工作目录，回车插入） |
| 换 tab | 点右栏 `TOOLS / TODOS / FILES / AGENTS` |
| 看文件夹 | FILES tab 点目录进、点 `..` 回上级 |

## 结构

| 文件 | 干什么 |
| --- | --- |
| `main.js` | 主进程：开窗口、IPC 转发、**会话列表/历史解析/文件树** |
| `preload.js` | 给界面开安全的 `window.pixelAPI` |
| `pi-bridge.js` | 找 node/pi、spawn 子进程、逐行解析 JSON 事件流 |
| `renderer.js` | 界面逻辑：三栏渲染、命令面板、工具记录、状态栏 |
| `index.html` / `style.css` | 95 像素风视觉（本地字体，不依赖外网） |
| `test/pi-wire.test.js` | pi 接线单测 |
| `test/screenshot.js` | 真开窗截图（待机 / 对话后） |
| `test/shot-extra.js` | 补拍各 tab 与浮层 |
| `test/verify-tools.js` | 用 `test/fixtures/pi-events.ndjson` 回放真实事件，验 TOOLS |
| `test/fixtures/pi-events.ndjson` | **真实抓下来的 pi 事件流**（含一次 `bash` 工具调用），当回归夹具 |

## 后端约定

- 命令：`node <pi cli.js> -p --mode json --session <会话文件> "<用户的话>"`
- 输出：换行分隔的 JSON 事件流（NDJSON）
- 回复正文：`message_update.assistantMessageEvent.type === 'text_delta'`
- 思考：`thinking_start / thinking_delta / thinking_end`
- 工具调用（助手声明）：`toolcall_start / toolcall_delta / toolcall_end`
- 工具**执行**（含真实结果，右栏记录用它）：
  `tool_execution_start / tool_execution_update / tool_execution_end`
  - `tool_execution_end` = `{toolName, args, result:{content:[{type:'text',text}]}}`
- 一轮结束：`agent_settled`
- 多轮：同一个 `--session` 文件 = 同一个会话

### 两个必须记住的坑

1. **stdin 必须断开**：`spawn` 的 `stdio` 必须是 `['ignore','pipe','pipe']`。
   pi 在 stdin 是管道时会一直等，表现为整个进程卡死。
2. **会话文件是 NDJSON**，不是一个大 JSON（`JSON.parse` 整个文件会失败）。
   一行一个条目，`type` 有 `session / model_change / message / ...`。

会话文件落在 `.sessions/chat-<n>.json`（E 盘，不占 C 盘）。
