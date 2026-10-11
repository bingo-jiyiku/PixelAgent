# PixelAgent

仿 95 复古像素终端风的桌面 AI Agent：**Electron 做界面，`pi` 做大脑**。
布局与操作学 opencode 桌面端（左会话 / 中时间线 / 右上下文面板），
皮肤是 Win95 + 像素风的黑粗边 + 硬阴影 + 点阵底。

## 用法

```bash
npm start                 # 打开窗口

# 纯逻辑断言（不开窗口，秒级，node 直接跑）
npm test                  # 四个一起跑 = 114 项断言
npm run test:md           # Markdown 渲染（43 项）
npm run test:parse        # todo 结果解析（31 项，样本来自真实抓包）
npm run test:bridge       # pi 参数组装（20 项，盯 @path 顺序与拼接）
npm run test:attach       # 附件落盘 + 路径安全（20 项）

# 真机（必须用 electron 跑，不是 node）
npm run verify:features   # 本轮功能总验收 + 截图（12~15）
npm run verify:tools      # 回放真实事件流验 TOOLS（08,10）
npm run shot              # 开窗截图（01,02）
npm run shot:extra        # 补拍各 tab / 浮层 / 模型选择器（03~07,09）
npm run test:pi           # pi 接线单测（真调一次 pi）
```

## 布局（opencode 式三栏）

```
┌ topbar  PIXELAGENT v1.0 · SESSION #n ···················· [—][□][✕]
├────────────┬──────────────────────────────┬─────────────────────┤
│ SESSIONS   │  TIMELINE                    │ TOOLS / TODOS /     │
│ 搜索框      │  空态：大标题 + 像素女孩      │ FILES / AGENTS      │
│ 会话列表    │  有消息：Markdown 消息流      │ 四个 tab 面板        │
│ + NEW      │                              │                     │
├────────────┴──────────────────────────────┴─────────────────────┤
│ ▣ 附件预览条（粘贴/拖拽/点选进来的图片）                          │
│ › 输入框（/ 命令 · @ 文件 · ! shell）    [+ IMG] [SEND] [■ STOP] │
│ IDLE │ 轮次 │ 用时 │ 模型▾ │ 思考 │ 图 │ 用量条 │ 时钟 │ ⚙      │
└──────────────────────────────────────────────────────────────────┘
```

### 操作

| 动作 | 怎么用 |
| --- | --- |
| 发送 | 输入框回车 或 点 `SEND` |
| 打断 | `ESC` 或 点 `■ STOP` |
| **发图片** | **直接 Ctrl+V 粘贴 / 拖进窗口 / 点 `+ IMG`**，预览条确认后随消息一起发。图本身坏了会在发送前就被拦下并说明原因；pi 万一丢图，时间线也会当场报出来 |
| **跑命令** | 输入以 `!` 开头（如 `!ls -la`），不经模型，直接在本机跑 |
| 新会话 | 左栏 `+ NEW` 或 `Ctrl+N` |
| 切模型 / 思考档位 | 点状态栏「模型」或 `Ctrl+M`（真拉 `pi --list-models`，132 个模型可搜） |
| **搜索会话** | 左栏搜索框或 `Ctrl+F`（扫全部会话正文，点命中直接跳） |
| **重命名会话** | 鼠标悬停左栏会话条 → `改名` |
| **导出会话** | 悬停 → `导出`（走 `pi --export`，产出独立 HTML） |
| **删除会话** | 悬停 → `删除`（**进系统回收站**，可恢复） |
| **换工作目录** | FILES tab 的 `📁 换目录`（pi 的 cwd 与 `@` 引用跟着走） |
| 切历史会话 | 点左栏任一条（回放消息 + 恢复待办） |
| 命令面板 | 输入框打 `/` |
| 引用文件 | 输入框打 `@` |
| 复制 / 重答 | 回复下方 `COPY` / `RETRY` |
| 看完整思考 | 点「思考中…」那行 |
| 看工具详情 | 右栏 TOOLS 点一条，展开 IN / OUT |
| 看容器能力 | 输入框打 `/agents` → 右栏列已装扩展 |

### 界面里能看到的真实数据（没有一处是写死的）

- **会话列表**：解析 `.sessions/chat-*.json`（NDJSON），出标题 / 轮次 / 时间
- **跨会话搜索**：线性扫全部会话文件的消息正文，返回会话 + 角色 + 上下文片段
- **上下文用量条**：`turn_end.message.usage.totalTokens` ÷ 该模型的 `context` 窗口
  （来自 `--list-models`），超 60% 转黄、85% 转红
- **`图` 标记**：当前模型是否支持看图（决定你发图有没有意义）；模型不看图 / pi 丢图时会在时间线明确报出来，而不是让 AI 假装看见了
- **TOOLS**：工具名 + 真实入参 + 真实输出
- **TODOS**：来自 `pi` 的 `todo` 工具结果（`details.todos`），切历史会话也会恢复
- **AGENTS**：真跑 `pi list` 拿到的扩展清单 + 本次会话的子代理 / 嵌套调用
- **FILES**：真读工作目录，可进目录、可换根目录
- **模型选择器**：真跑 `pi --list-models`，带上下文窗口 / thinking / 图片能力

> TODOS 能用，是因为 `ext/todo.ts` 给 pi 补了一个 `todo` 工具 ——
> pi 本体**不带** todo（官方只在 `examples/extensions/todo.ts` 给了个示例，没装）。

## 结构

| 文件 | 干什么 |
| --- | --- |
| `main.js` | 主进程：窗口、IPC、会话 CRUD / 历史解析 / 文件树 / 模型目录 / 扩展清单 / shell 执行 / 搜索 |
| `preload.js` | 给界面开安全的 `window.pixelAPI` |
| `pi-bridge.js` | 找 node/pi、spawn 子进程、逐行解析事件流；`buildArgs()` 可单测 |
| `md.js` | Markdown 渲染器（纯逻辑，零依赖） |
| `parse.js` | todo 结果解析 + 「图有没有真进请求」判定（纯逻辑，零依赖） |
| `attach.js` | 图片附件**体检 + 落盘**：解不出来的图当场拒收并给出真实原因；文件名消毒（纯 Node） |
| `renderer.js` | 界面逻辑：三栏渲染、附件、shell、命令面板、用量条、模型选择器、丢图提示 |
| `ext/todo.ts` | **PixelAgent 自带的 pi 扩展**：给 pi 补 `todo` 工具 |
| `index.html` / `style.css` | 95 像素风视觉（本地字体，不依赖外网） |
| `test/*.test.js` | 纯逻辑断言（md / parse / bridge / attach） |
| `test/verify-features.js` | 真机验收本轮功能（含端到端图片链路 + 两层防丢图 + 截图） |
| `test/verify-tools.js` | 回放真实事件流验 TOOLS |
| `test/analyze-events.js` | 事件流取证工具：`node test/analyze-events.js <日志>` |
| `test/probe-trash.js` | 单量 `shell.trashItem` 的真实行为（抛没抛 / 文件还在不在） |
| `test/ocr.ps1` | ⚠ **未接线**：早期「模型不看图时用 Windows OCR 兜底」的实验脚本，留作手工参考 |
| `test/fixtures/load-image.js` | 图片夹具加载器：**先验夹具自己合法**，不合格就抛错，不让坏夹具伪装成产品缺陷 |
| `test/fixtures/*` | 真实抓下来的事件流 / 模型表 / 合法 PNG，当回归夹具 |

### 发图的链路（三层，缺一层就会「静默失败」）

```
粘贴/拖拽/点选 → dataURL
   ↓ attach.js: probeImage 体检（签名 + chunk CRC + inflate）   ← 第一层：拦坏图
   写盘 .attachments/xxx.png
   ↓ pi-bridge buildArgs → @绝对路径（独立 argv，问题永远最后）  ← 第二层：老坑，见坑#4
   pi 事件流 message_start(user)
   ↓ parse.js: inspectUserContent（数 image 块 + 扫丢图标记）    ← 第三层：抓静默丢图
   时间线报出「图片没能进入请求：…」或正常继续
```


## 后端约定

- 命令：`node <pi cli.js> -p --mode json [选项…] [@附件…] "<用户的话>"`
- 选项：`--session <文件>` / `--provider X --model Y` / `--thinking L`
  / `--extension <扩展路径>` / `--no-tools` / `--tools +name`
- 输出：换行分隔的 JSON 事件流（NDJSON）
- 回复正文：`message_update.assistantMessageEvent.type === 'text_delta'`
- 思考：`thinking_start / thinking_delta / thinking_end`
- 工具声明：`toolcall_start / toolcall_delta / toolcall_end`
- 工具**执行**：`tool_execution_start / tool_execution_update / tool_execution_end`
- 一轮结束：`agent_settled`
- 用量：`turn_end.message.usage` = `{input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost}`

### 十一个必须记住的坑

1. **stdin 必须断开**：`spawn` 的 `stdio` 必须是 `['ignore','pipe','pipe']`。
   pi 在 stdin 是管道时会一直等，表现为整个进程卡死。
2. **会话文件是 NDJSON**，不是一个大 JSON（整体 `JSON.parse` 会失败）。
3. **`tool_execution_end` 里没有 `args`**！args 只在 `tool_execution_start` 才有。
   要按 `toolCallId` 关联两边，否则工具卡片入参永远渲染成 `{}`。
4. **`@path` 必须是独立 argv，绝不能拼进 prompt**。
   拼成 `"@图.png 这张图里有什么"` 一个参数时，pi 把**整串**当成路径：
   `Error: File not found: E:\...\a.png 这张图里有什么…`。
   正确顺序：`[选项…] [--session …] @图.png … "<问题>"`，问题永远在最后。
5. **`details` 在 `ev.result.details`，不在事件顶层**。
   写解析时两处都要看（`parse.js` 就是双路）。
6. **并发 pi 会互相抢 `settings.json.lock`**。抢不到 pi 直接判定配置无效，
   表现是莫名其妙的 `Lock file is already being held` + `No API key found` ——
   看起来像认证坏了，其实只是撞锁。所以：配置目录隔离
   （`PI_CODING_AGENT_DIR`）+ 查询串行排队 + 撞上退避重试。
7. **默认模型可能看不懂图**。`--list-models` 最后一列 `images` 才是真相；
   发图前必须查这一列并给用户明确警告，否则会得到一个"在瞎猜"的 AI。
8. **扩展的 `parameters` 用纯 JSON Schema 就行**，不必引 typebox。
   `ext/` 目录往上找不到 pi 的 `node_modules`，引外部依赖反而会加载失败。
   另外扩展要用 `.ts`（`.js` 在无 `type:module` 的目录里会被当 CommonJS，
   `export default` 直接语法报错）。
9. **Electron 里的测试脚本必须用 `electron` 跑**，不能用 `node`：
   纯 node 下 `require('electron')` 返回的是二进制路径而不是模块，
   `ipcMain` 是 `undefined`，脚本会以 `TypeError` 退出。
   更阴的是写成 `node x.js; echo "exit=$?"` 时，最后那个 echo 会把退出码洗成 0。
   跑测试永远要同时拿到 **退出码 + PASS 数 + FAIL 数**。
10. **pi 丢图是静默的**（这条最贵，害我查了两轮）。图如果 pi 处理不了
    （解不开 / 太大），它**不报错**：把 `image` 块删掉，只在 user 消息的**文本**里
    留一句 `[Image omitted: could not be resized below the inline image size limit.]`
    （模型不看图时是另一句 `[Current model does not support images …]`）。
    后果：界面上一片正常，AI 却在瞎猜 —— 或者自己跑去 `bash`/`identify` 手动查文件。
    ⇒ 两端都要防：
    - 发之前（`attach.js: probeImage`）：PNG 要查 chunk CRC + `inflate` 得通，
      不合格直接拒收并**把真实原因**显示给用户，别浪费一次模型调用；
    - 发之后（`parse.js: inspectUserContent` + `renderer.js`）：读 pi 回显的
      user 消息，数 `image` 块、扫那两句标记，丢图就当场在时间线里报出来。
    判定用的是**真实抓包**里的原话，不是猜的措辞。

> **配套教训一：测试夹具坏了会伪装成产品缺陷。** 上面那条我之所以查了两轮，
> 是因为端到端验收喂的"测试图片"是我手搓的 base64 —— IDAT 的 **CRC 和 Adler-32 都是错的**，
> `zlib.inflate` 直接报 `incorrect data check`。图压根解不开，pi 当然失败。
> 而"夹具不合法"和"产品有毛病"在报告里长得一模一样（都是同一条断言红）。
> ⇒ 现在 `test/fixtures/load-image.js` 在加载夹具时**先验它自己**
> （复用生产代码的 `probeImage`），不合格就抛错；
> `npm test` 第一步就跑这个自检。夹具的事，夹具自己先喊。

> **配套教训二：断言会因为「不是你想要的证据」而假通过或假红。** 这一轮踩了三次：
> ① 断言里写 `arr[0].field`，断言一失败数组是空的就抛异常，**整个文件中断**，
>    后面的断言静默不跑 —— 又变成"测试没跑起来"和"全绿"分不清。取值一律走 `at(arr, 0)`。
> ② 端到端轮询只看"会话文件最后一条 user 消息带不带图"：那个文件是**跨轮累积**的，
>    上一轮的带图消息还在里面 ⇒ 这条**假通过**（拿旧数据当本轮结果），
>    同时实时事件流的断言**假红**（pi 其实还没产出事件）。两边都不可信。
>    ⇒ 判断依据必须是**本轮新增的证据**：先取基线（发送前已有几条 user 消息），
>    只认"增量 > 0"那一条。
> ③ `window.pixelAPI.history()` 是 `ipcRenderer.invoke`，返回 **Promise**。
>    写成同步调用，`h.msgs` 永远是 `undefined`，计数恒为 0，断言永远红。必须 `then` 出来。

11. **`shell.trashItem` 会「移走文件之后仍然 reject」**（本机实测：
    `electron test/probe-trash.js` 把 name/message/code 和「文件还在不在」一起打出来）。
    它的错误是 `Operation was aborted`，
    但**文件确实已经从原路径消失**。只按异常判，界面就会弹"删除失败" ——
    用户看了假警报还得自己去找文件；而文件其实已经不在了。
    ⇒ 以**文件还在不在**为事实依据，异常只当补充说明带回去
    （`{ok:true, trashNote:'...'}`），界面据此说"可恢复性未能确认"。
    这条的普适教训：**外部 API 的成败，要落在一个你自己能独立核实的事实上**，
    不能只看它抛没抛异常。

> 另：Electron 里 `window.prompt` / `window.confirm` 不可用（会被直接忽略），
> 需要自绘对话框（`index.html` 的 `#mask-input`）。

### 配置目录（重要）

PixelAgent **不共用** `~/.pi/agent`，而是用项目下的 `.pi-agent/`：

- 共用会互相抢锁 —— 而且 PixelAgent 一旦被强杀会留下 stale 锁，
  把**终端里的 pi 一起弄坏**。隔离掉，各用各的。
- 首次启动自动从 `~/.pi/agent` 抄 `auth.json` / `models.json` / `settings.json` 过来。
- `.pi-agent/` 里有凭据，**已在 `.gitignore`**，绝不要提交。

会话文件落在 `.sessions/chat-<n>.json`，图片附件落在 `.attachments/`（都在 E 盘）。
