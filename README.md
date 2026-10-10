# PixelAgent

复古像素终端风的桌面 AI 助手：Electron 做界面，`pi` 做大脑，流式打字机显示回复。

## 用法

```bash
npm start        # 打开窗口
npm run test:pi  # Pi 接线单测（真调一次 pi，验证流式 + 多轮）
npm run shot     # 自动开窗并截图到 shots/
```

## 结构

| 文件 | 干什么 |
| --- | --- |
| `main.js` | Electron 主进程：开窗口、IPC 转发 |
| `preload.js` | 给界面开安全的 `window.pixelAPI` |
| `pi-bridge.js` | 找 node/pi、spawn 子进程、逐行解析 JSON 事件流 |
| `renderer.js` | 界面逻辑：打字机、状态标签、工具状态行 |
| `index.html` / `style.css` | 像素风视觉（本地字体，不依赖外网） |
| `test/pi-wire.test.js` | 接线单测 |
| `test/screenshot.js` | 真开窗截图 |

## 后端约定

- 命令：`node <pi cli.js> -p --mode json --session <会话文件> "<用户的话>"`
- 输出：换行分隔的 JSON 事件流；回复看 `message_update.assistantMessageEvent.type === 'text_delta'`
- 多轮：同一个 `--session` 文件就是同一个会话（已实测）
- 会话文件落在 `.sessions/`（E 盘，不占 C 盘）
