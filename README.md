# PixelAgent

仿 95 复古像素终端风的桌面 AI Agent：**Electron 做界面，`pi` 做大脑**。
布局与操作学 opencode 桌面端（左会话 / 中时间线 / 右上下文面板），
皮肤是 Win95 + 像素风的黑粗边 + 硬阴影 + 点阵底。

## 用法

```bash
npm start            # 打开窗口
npm run test:pi      # Pi 接线单测（真调一次 pi，验流式 + 多轮）
npm run test:md      # Markdown 渲染器断言（纯逻辑，43 项）
npm run shot         # 开窗截图：待机 + 对话后（shots/01,02）
npm run shot:extra   # 补拍：FILES/TOOLS/历史回放/命令面板/文件引用/模型选择器（03~07,09）
npm run verify:tools # 回放真实事件流验 TOOLS + 展开工具卡片（08,10）
```

## 布局（opencode 式三栏）

```
┌ topbar  PIXELAGENT v1.0 · SESSION #n ·················· [—][□][✕]
├────────────┬──────────────────────────────┬───────────────────┤
│ SESSIONS   │  TIMELINE                    │ TOOLS/TODOS/      │
│ 会话列表    │  空态：大标题 + 像素女孩      │ FILES/AGENTS      │
│ + NEW      │  有消息：Markdown 消息流      │ 四个 tab 面板      │
├────────────┴──────────────────────────────┴───────────────────┤
│ › 输入框（/ 命令 · @ 文件）              [SEND] [■ STOP]      │
│ IDLE │ 轮次 │ 用时 │ 模型▾ │ 思考 │ 上下文用量条 │ 时钟 │ ⚙  │
└──────────────────────────────────────────────────────────────┘
```

### 操作

| 动作 | 怎么用 |
| --- | --- |
| 发送 | 输入框回车 或 点 `SEND` |
| 打断 | `ESC` 或 点 `■ STOP` |
| 新会话 | 左栏 `+ NEW` 或 `Ctrl+N` |
| 切模型 / 思考档位 | 点状态栏「模型」或 `Ctrl+M`（真拉 `pi --list-models`，132 个模型可搜） |
| 切历史会话 | 点左栏任一条（回放该会话消息，上下文延续） |
| 命令面板 | 输入框打 `/`（上下选、回车执行） |
| 引用文件 | 输入框打 `@`（候选来自工作目录，回车插入） |
| 复制回复 | 回复下方 `COPY` |
| 再答一次 | 回复下方 `RETRY`（重发上一条输入） |
| 看完整思考 | 点「思考中…」那行，展开完整思维链 |
| 看工具详情 | 右栏 TOOLS 点一条，展开完整入参（IN）与输出（OUT） |
| 看文件夹 | FILES tab 点目录进、点 `..` 回上级 |
| 复制代码 | 代码块右上角 `COPY` |

### 界面里能看到的真实数据

- **会话列表**：解析 `.sessions/*.json` 的 NDJSON，出标题 / 轮次 / 时间
- **上下文用量条**：`turn_end.message.usage.totalTokens` ÷ 该模型的 `context` 窗口
  （来自 `--list-models`），超 60% 转黄、85% 转红
- **TOOLS**：工具名 + 入参 + 真实输出（来自 `tool_execution_end.result`）
- **FILES**：真读工作目录，可进目录
- **模型选择器**：`pi --list-models` 的真实结果，带每个模型的上下文窗口 /
  是否支持 thinking / 是否支持图片

## 结构

| 文件 | 干什么 |
| --- | --- |
| `main.js` | 主进程：窗口、IPC、会话列表 / 历史解析 / 文件树 / **模型目录** |
| `preload.js` | 给界面开安全的 `window.pixelAPI` |
| `pi-bridge.js` | 找 node/pi、spawn 子进程、逐行解析事件流（支持 `extraArgs` 传模型参数） |
| `md.js` | **Markdown 渲染器**（纯逻辑，零依赖，node 可直接单测） |
| `renderer.js` | 界面逻辑：三栏渲染、命令面板、工具卡片、用量条、模型选择器 |
| `index.html` / `style.css` | 95 像素风视觉（本地字体，不依赖外网） |
| `test/md.test.js` | Markdown 渲染断言（43 项，含 XSS 与代码块边界） |
| `test/pi-wire.test.js` | pi 接线单测 |
| `test/screenshot.js` | 真开窗截图（待机 / 对话后） |
| `test/shot-extra.js` | 补拍各 tab、浮层、模型选择器 |
| `test/verify-tools.js` | **回放真实事件流**验 TOOLS（含展开卡片断言） |
| `test/fixtures/pi-events.ndjson` | 真实抓下来的 pi 事件流（180 条，含一次 `bash` 调用）当回归夹具 |
| `test/fixtures/pi-models.txt` | `--list-models` 的真实输出，供解析回归 |

## 后端约定

- 命令：`node <pi cli.js> -p --mode json --session <会话文件> [--provider X --model Y] [--thinking L] "<用户的话>"`
- 输出：换行分隔的 JSON 事件流（NDJSON）
- 回复正文：`message_update.assistantMessageEvent.type === 'text_delta'`
- 思考：`thinking_start / thinking_delta / thinking_end`
- 工具调用（助手声明）：`toolcall_start / toolcall_delta / toolcall_end`
- 工具**执行**：`tool_execution_start / tool_execution_update / tool_execution_end`
- 一轮结束：`agent_settled`
- 用量：`turn_end.message.usage` = `{input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost}`
- 多轮：同一个 `--session` 文件 = 同一个会话

### 四个必须记住的坑

1. **stdin 必须断开**：`spawn` 的 `stdio` 必须是 `['ignore','pipe','pipe']`。
   pi 在 stdin 是管道时会一直等，表现为整个进程卡死。
2. **会话文件是 NDJSON**，不是一个大 JSON（`JSON.parse` 整个文件会失败）。
   一行一个条目，`type` 有 `session / model_change / message / ...`。
3. **`tool_execution_end` 里没有 `args`**！args 只在 `tool_execution_start` 才有，
   end 只给 `result`。要按 `toolCallId` 把两边的数据关联起来 ——
   否则工具卡片的入参会渲染成 `{}`。
4. **`--list-models` 的解析靠列位置**：132 个模型、4 个 provider。
   列表变了要重跑一次存回 `test/fixtures/pi-models.txt`。

会话文件落在 `.sessions/chat-<n>.json`（E 盘，不占 C 盘）。
