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
| 发送 | 输入框回车 或 点 `发送`（可在设置里改成 Enter 换行 / Ctrl+Enter 发送） |
| 打断 | `ESC` 或 点 `停止` |
| **发图片** | **直接 Ctrl+V 粘贴 / 拖进窗口 / 点 `图片`**，预览条确认后随消息一起发。图本身坏了会在发送前就被拦下并说明原因；pi 万一丢图，时间线也会当场报出来。张数上限在设置里调（默认 4） |
| **跑命令** | 输入以 `!` 开头（如 `!ls -la`），不经模型，直接在本机跑 |
| 新会话 | 左栏 `新建` 或 `Ctrl+N` |
| 切模型 / 思考档位 | 点状态栏「模型」或 `Ctrl+M`（真拉 `pi --list-models`，130 个模型可搜）。列表**按服务商分组、可折叠**（收起状态会记住），每行悬停有 `配置` / `测试`：`配置` 能改用量条的分母并告诉你这个数是谁定的；`测试` 会**真发一次最小请求**看这个模型通不通。**故意没有 `/model` 命令** —— 这里就是入口，多开一条只会走偏 |
| **搜索会话** | 左栏搜索框或 `Ctrl+F`（扫全部会话正文，点命中直接跳） |
| **重命名会话** | 悬停左栏会话条 → `改名`（可留空恢复自动标题；**重名会被拦下并告诉你撞的是哪一条**） |
| **导出会话** | 悬停 → `导出`，或 `/export`。格式在**设置**里选：独立网页 / Markdown 文档 / 原始 JSON |
| **删除会话** | 悬停 → `删除`（**进系统回收站**，可恢复）。删光最后一条会**主动回主页**；删的若是当前那条但还剩别的，会**真的把那一条的历史读出来**（不是只换个编号） |
| **换工作目录** | FILES tab 的 `换目录`，或在**设置**里直接填/选（pi 的 cwd 与 `@` 引用跟着走） |
| **设置** | 状态栏齿轮，或打 `/settings`：工作目录 / 默认模型 / 思考档位 / Enter 行为 / 图片上限 / 主题色 / 吉祥物动画 / 紧凑模式 / 自动滚到底 / 导出格式 |
| 切历史会话 | 点左栏任一条（回放消息 + 恢复待办） |
| **命令面板** | 输入框打 `/`：模糊搜索 + 命中高亮 + 分组 + 最近使用 + 无结果提示。支持**带参数连着写**（`/rename 我的会话`） |
| 引用文件 | 输入框打 `@` |
| 复制 / 重答 | 回复下方 `复制` / `重答` |
| 看完整思考 | 点「思考中…」那行 |
| 看工具详情 | 右栏 TOOLS 点一条，展开 入参 / 返回 |
| 看容器能力 | 输入框打 `/agents` → 右栏列已装扩展 |

### 欢迎区的吉祥物

粉色双马尾少女**坐在电脑前办公**，四态由 pi 的事件驱动：

| 状态 | 表现 |
| --- | --- |
| 空闲 | 呼吸起伏 + 键盘上有一颗键在闪 |
| 思考中 | 上身轻摇 + 头右侧冒三个点的气泡 + 屏幕上的光标在跳 |
| 处理中 | 整排键在闪 + 齿轮脉冲 + 屏幕扫描线加快 |
| 完成 | 轻轻跳一下 + 屏幕打勾 + 头顶三颗星 |

人物是老板给的原图，`tools/make-girl.js` **只做去白底 + 裁边，一个像素都没重画**
（重画一定会改掉发绳、蝴蝶结、裙褶这些细节，那就不是"这个形象"了）。
桌椅显示器键盘是 CSS 搭的；**桌面压住裙摆**——实测垂直重叠 38px，
就靠这一条读出"坐着"（见 `README` 坑 15 那台截图自检工具）。
⚠️ 这里**故意没有椅背**：她的双马尾最宽处几乎占满人物框（311/315 px），
椅背只会在马尾与身体的缝里露出两条惨白竖条，读起来像"背后贴了张白卡片"。
`tools/girl-profile.js` 就是量这件事的，别再把椅子加回来。

### 界面里能看到的真实数据（没有一处是写死的）

- **会话列表**：解析 `.sessions/chat-*.json`（NDJSON），出标题 / 轮次 / 时间
- **跨会话搜索**：线性扫全部会话文件的消息正文，返回会话 + 角色 + 上下文片段
- **上下文用量条**：`turn_end.message.usage.totalTokens` ÷ 该模型的上下文窗口
  （来自 `--list-models` 第 3 列），超 60% 转黄、85% 转红。
  **分母是谁定的、从哪来，界面上要能查到**（点用量条看明细 / 模型行点「配置」）——
  实测 `agent-plan/ark-code-latest` 在 `.pi-agent/models.json` 里只有 `{"id":"..."}`，
  一个 `contextWindow` 都没声明，pi 就按 `contextWindow ?? 128000` 兜底报 `128K`
  （`formatTokenCount` 用 ÷1000，见坑 21）。
  觉得不准可以在这个模型行点「配置」填一个覆盖值，**只改用量条的分母，不改 pi 的能力**。
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
| `pal.js` | 命令面板的**纯逻辑**：模糊匹配 / 高亮分段 / 候选排序 / 参数解析（零依赖，可 node 直测） |
| `attach.js` | 图片附件**体检 + 落盘**：解不出来的图当场拒收并给出真实原因；文件名消毒（纯 Node） |
| `renderer.js` | 界面逻辑：三栏渲染、附件、shell、命令面板、**设置面板**、用量条、模型选择器（分组折叠 + 行内「配置 / 测试」）、丢图提示 |
| `ext/todo.ts` | **PixelAgent 自带的 pi 扩展**：给 pi 补 `todo` 工具 |
| `index.html` / `style.css` | 95 像素风视觉（本地字体，不依赖外网）+ 欢迎区的「办公场景吉祥物」 |
| `assets/girl.png` | 欢迎页形象：老板给的原图，**只去了白底 + 裁边，一个像素都没重画**（`tools/make-girl.js`） |
| `test/*.test.js` | 纯逻辑断言（md / parse / pal / bridge / attach） |
| `test/verify-features.js` | 真机验收本轮功能（含端到端图片链路 + 两层防丢图 + 中文体检 + 设置/面板/命名 + **上下文来源/删空回主页/模型配置与折叠** + 截图） |
| `test/verify-tools.js` | 回放真实事件流验 TOOLS |
| `test/shot-model.js` | 模型框取证：分组折叠（按**行数真变**判）+ 行内「配置」弹框的排版几何（控件两两不重叠 / 不溢出 / 长文案换行而非溢出）+ Esc，全部带截图 |
| `test/probe-usage.js` | 单量「上下文分母到底是多少、从哪来」：从主进程直接统计模型表里 context 的分布 + 当前模型的命中情况 |
| `test/probe-mcfg.js` | 单量「模型配置保存卡在哪」：**同时**打出「值进没进输入框 / `MCFG.sel` 还在不在 / 主进程回了什么 / 磁盘上有没有」四个量 |
| `test/probe-esc.js` | 单量「Esc 被哪个浮层接住了」：dispatch 前后把四个浮层的 display 全打出来（handler 里的分支顺序就是答案） |
| `test/analyze-events.js` | 事件流取证工具：`node test/analyze-events.js <日志>` |
| `test/probe-trash.js` | 单量 `shell.trashItem` 的真实行为（抛没抛 / 文件还在不在） |
| `test/shot-girl.js` | 吉祥物四态截图 + **像素自检**（防"截到别的窗口"，见坑 15）+ 键盘四态动画断言（护着 `.f-key` 那次槽位改造） |
| `test/shot-settings.js` | 设置面板取证：滚动条宽度 / 标题 / 标签换行（按行数判，见坑 18）/ 主题色换皮，全部带反向验证 + 整窗与局部截图 |
| `test/zoom-scene.js` | 场景每个元素单独放大 + 打印中心像素值（眼睛和图像管线都不可靠时靠数值） |
| `tools/make-girl.js` | 抠图（从四边泛洪去白底 + 羽化 + 裁边），同时导出 `decodePng/cutout` 给测试复用 |
| `tools/girl-profile.js` | 量人物轮廓（每行的不透明范围）—— "椅子该多窄"这种问题靠它回答 |
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

### 二十二个必须记住的坑

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

12. **界面文案一律中文，但"面向用户的字符串"散在 4 个地方，改一边会漏。**
    这一轮把英文界面全转中文时，漏了三次，每次都是**同一类错**：
    | 漏在哪 | 为什么漏 | 怎么才发现 |
    |---|---|---|
    | `md.js` 里代码块的 `>COPY<` | 它是渲染 Markdown 时**拼**出来的，只有"消息里恰好含代码块"时才进 DOM | 源码级审计扫出来的 |
    | `renderer.js` 文件面板的 `DIR` / `FIL` | 面板要切到「文件」tab、且目录里有内容才渲染 | 同上 |
    | 对话框标题 / 状态灯 / 思考档位 | 是**运行时**赋值的（`setState`、`openPalette`），静态 HTML 里看不到 | 读代码 + 真机截图 |
    ⇒ **动手前先把"文案的来源"列出来**：静态 HTML、运行时赋值、拼字符串生成的 HTML。
      三类都要覆盖，只查 `index.html` 等于没查。

13. **判"英文清干净了没有"，用「扫结构」而不是「列选择器清单」。**
    第一版体检是**手写一份 class 名单**（`.who` / `.rtab` / `.pal-hd` …）逐个查，
    看着很全。反向验证时我把标题改回 `SESSIONS` —— 而 `.cap-t` 不在名单里，
    断言**照样全绿**。这就是"只扫我想到的地方"。
    ⇒ 正确姿势：从 `body` 往下走，**凡是"叶子元素"（只有一段文字）都算候选标签位**，
      只排除"内容/数据位"（用户正文、模型名、路径、工具名、`<pre>` 原始输出），
      每个排除都写理由。改动后**必须做反向验证**：故意塞个英文标签，看它红不红。
      实测这套结构式扫描一次扫到 **142 个标签位**，比自己列的清单多一倍。

14. **两步验证都要做，因为它们会互相兜底 —— 但也会互相"传染"假绿。**
    反向验证时我踩了两次假绿，都是**排除规则写太宽**：
    ① 把 `pre` 写进"按 class 排除"的集合 —— 可 `<pre>` 是**标签名**不是类名，
       一个都没排掉（改完才发现，比误报更隐蔽的是"以为排了其实没排"）；
    ② 扫描器写成"含 `<` 就整条跳过" —— 于是 `'>COPY</button>'` 这种
       **HTML 字符串里的用户可见文字**被一起跳掉了。
    ⇒ 排除规则本身要**反向验证**：把坏样本塞回去，看它到底红不红。
      只对"正向全绿"负责的排除规则，等于没写。

> **配套教训三（同一族，第三次）：排除的**粒度**也得反向验证。**
> 命令面板的候选项（`.pal-k` / `.pal-d`）里装着命令键和带路径的文件名，天生是英文，
> 所以要排掉 —— 但第一版我把整个 **`#pal-list`** 写进了「按 id 排除」的集合：
> 于是面板里的**分组标题**（"最近使用"）、**无结果提示**、**参数提示**也一起被排掉了。
> 它们是真标签，却成了体检的盲区 —— 又是一次"以为排了其实没排"。
> ⇒ 改成**按 class 排**（只排 `.pal-k` / `.pal-d`），并在体检里加两条**正向确认**：
>   ① 体检时面板必须**是打开的**（否则那两条 class 排除规则一条都没被执行到，等于空转）；
>   ② 分组标题（`.pal-group`）和设置面板行标题（`.set-lb`）**必须**出现在被检查的名单里。
>   这样"排得太宽"和"排了但没生效"两种错都会被立刻抓住。

15. **`webContents.capturePage()` 可能拍到的不是你的窗口，而是屏幕。**
    这一轮最阴的一次：四张吉祥物截图里有两张 **md5 完全相同**。
    我自己那套是带动画的，**字节一致本身就是铁证**：拍到的是一张静态画面。
    真凶是当时还有一个 PixelAgent 实例开着模型对话框，压在我窗口上方，
    而 `capturePage` 走了屏幕捕获那条路，于是"截图成功"和"截到要截的东西"分了家
    —— 拿去做验收的却是别人的窗口。
    ⇒ 两手都要：① 拍之前 `win.show() + focus() + setAlwaysOnTop(true) + moveTop()`；
      ② 每张图做**像素自检**（本项目的做法：办公场景最外圈是 3px 纯黑描边，
        所以顶边那一行必须是整行深色。被对话框盖住这一行立刻会花），
        不过就报 ❌ 并且**退出码非 0**，绝不静默写文件。
    通用形态：**"拿到了结果"和"拿到了正确的结果"必须能分开说**。

16. **界面上的开关必须是真开关 —— 摆了不生效的，比不摆更坏。**
    老板这轮的原话是"设置要有设置该有的功能"，之前那个面板是一堆只读的 `键/值`。
    改的时候立了三条规矩，每条都有对应的验收：
    | 规矩 | 怎么保证 |
    |---|---|
    | 主进程有字段 + 校验 | 越界值会被夹回默认（实测 `maxImages:999 → 4`，`accent:'彩虹' → 'lav'`） |
    | 界面上真的起作用 | 关掉动画后 `body.no-anim` 必须出现；改主题色后 `--lav` 必须变 |
    | 存得下、重启还在 | 保存后直接读 `.pixelagent.json` 对账（先在盘上记下旧值，确认**真的变了**，否则断言是空转） |
    另一个细节：**主进程不认识的键必须报出来**（`droppedKeys`）。
    界面把 `mascotAnim` 敲成 `mascot` 时，如果默默丢掉，
    用户看到的就是"点了保存但没反应"——这种问题没有回执就只能靠猜。
    同理，**导出格式**这个设置如果不改内容只改后缀，那就是假设置；
    所以 `md` / `json` 两条导出路径是真写出来的（`sessionToMarkdown` / 直接搬走会话文件）。

17. **把滚动条全局藏掉 = 把「下面还有内容」的唯一证据也藏了。**
    `style.css` 顶上原本是 `* { scrollbar-width: none }` + `::-webkit-scrollbar { display: none }`，
    非常干净 —— 直到设置面板做出来才付出代价：
    实测设置内容 **1129px**、可视区只有 **685px**（`.dialog { max-height: 84vh }`），
    **底下 5 个设置项一个提示都没有**，用户会读成"设置就只有这几项"。
    滚动条不是装饰，它是"还有东西"的唯一证据。
    ⇒ 改成全局恢复 + 统一 95 造型（灰凹槽 / 白滑块 / 3px 黑描边），
      而不是去手写一张"哪些容器要滚动条"的名单 —— 名单一定会漏（新加一个面板就漏一个），
      而且**漏了不会报错**，只会静默地又藏起来。
    ★ 两个"改了没效果还不报错"的坑（写自定义滚动条必踩）：
      ① 全局那条 `display: none` 会继续作用到**同一个伪元素**，
         `.dlg-body::-webkit-scrollbar` 里不显式写 `display: block` 就白改；
      ② 别留 `scrollbar-width: none`：Chromium 会优先用标准属性，**直接忽略**下面那些自定义规则。
    验收是把"隐形"变成数字：`#set-body` 的 `offsetWidth - clientWidth` 必须 **13px**
    （实测改前 0 / 改后 13），并且带一次反向验证（临时 `overflow-y: hidden` 后必须归零，
    否则这条测量可能恒真）。同理，标题里那对空括号 `设置()` / `模型()`
    也是同一类毛病 —— "看不出里面有什么"，现在改成 `设置(10 项)` / `模型(130)`。

18. **`scrollWidth > clientWidth` 判"文字有没有换行"是假阴性。**
    给设置面板写"标签没被压到换行"这条断言时，我第一版用的就是溢出判据。
    结果 10 个标签的 `scrollWidth` 与 `clientWidth` **全部等于 136px** ——
    3 个字的"主题色"和 7 个字的"新消息自动到底"量出来一模一样。
    原因：`white-space: normal` 的元素**换行而不是溢出**，`scrollWidth` 根本不会涨。
    ⇒ 这条断言在"没换行"和"换了行"两种情况下**都返回绿**，等于没写。
    正确判据是**行数**：`盒子高度 ÷ line-height`（`line-height: normal` 时用 `fontSize × 1.2` 兜底）。
    并且要在脚本里做**反向验证**：把某个标签文字临时换成超长串，
    断言它必须被判成 `lines > 1`（实测换成超长串 → 3 行）。
19. **浮层必须自己吃掉 Esc —— 少写一支，代价是一次静默的误中断。**
    文档级 `keydown` 里原来只有 `mask-input` / `mask-model` 两支：
    ```js
    if (e.key === 'Escape') {
      if (!$('mask-input').classList.contains('hidden')) { closeInput(false); return; }
      if (!$('mask-model').classList.contains('hidden')) { closeModelPicker(); return; }
      if (document.activeElement !== input) doAbort();     // ← 设置面板开着时会掉到这里
    }
    ```
    设置面板开着按 Esc：前两支都不命中，于是掉进 `doAbort()` ——
    **"想关掉设置"变成"把正在跑的这轮中断掉"，而面板还开着**。补一支就好：
    `if (!mask.classList.contains('hidden')) { closeSettings(true); return; }`
    ★ 这条 bug 差点测不到，两个原因都要记：
      ① `doAbort()` 里有 `if (!S.busy) return`，测试时没在跑就**什么都不发生**，
         所以验收用的中断计数必须放在这个 busy 判断**之前**（`window.__pixelAborts`）；
      ② 中断分支的前提是 `document.activeElement !== input`，而输入框启动时是自动聚焦的，
         **不先把焦点移到别处就永远走不到那一支**。实测把焦点放进面板（`#set-cwd`）才算前提成立。
    ★★ 最值一提的是：我给这条修复写的"反向验证"（无浮层时 Esc 应当仍然中断）**第一版红了** ——
       因为它漏了 ② 这个前提，在输入框还聚焦时按 Esc 本来就该什么都不做。
       **反向验证把反向验证自己抓了。** 这正是它该有的样子：
       反向验证红了，第一件事是检查**前提写全了没有**，而不是回头去改产品。
       现在那段会把前提一起量出来并单独断言（`焦点在面板内` 必须为真），
       同时把反向那条的焦点先 `blur()` 掉 —— 否则它还是空转。
    ★★ 后来加了模型配置框（`#mask-mcfg`），同一条毛病**又犯了两次**，值得把规矩写进代码：
      ① 新浮层不会自动被 Esc 关掉 —— **每加一个浮层，必须在那一支里加一行**；
      ② 更要命的是"手写判断顺序"会漂：`mask-mcfg` 那支排在 `mask-model` **后面**，
         于是"模型框 + 配置框"两层都开着时按 Esc，关掉的是**下面**那个模型框，
         最上面的配置框纹丝不动 —— 用户按了 Esc 却像没反应。
         （真是这样被 `test/shot-model.js` 抓住的：PASS 47 / FAIL 2。）
      ⇒ 最终改成**别手写顺序，从 DOM 里排**：同层浮层 `z-index` 一样，
         DOM 里越靠后越在上面，所以取 `sort(compareDocumentPosition)[0]` 就是最上面那层。
        手写清单一定会在新加浮层时漏掉，而**漏了不会报错**，只会让 Esc 关错目标。
20. **`addMsg` 会把主页藏掉 —— "回主页"和"说一句"在时间线里是互斥的。**
    老板原话：「当删除完所有会话时，没有主动返回主页」。
    代码原来是这样：
    ```js
    if (!left) { welcome.classList.remove('hidden'); }   // 先把主页放出来
    addMsg('step', 'SYS', '> 会话 #x 已移入回收站');       // ← addMsg 里 showTimeline() 又把它藏了
    ```
    结果用户只看到一条"已移入回收站"，主页没了。**功能是对的、顺序是错的**，
    而且两句话各自都对，只有摆在一起才错。
    ⇒ 提示改走**时间线之外**的 `toast`（`#toast`，2.6 秒自隐）。
      判据也换了个地方：断言 `#welcome` 不 hidden **并且** `#log` 里**搜不到**那句话。
    ★ 同一个函数里还埋着第二个更阴的：删掉当前会话但**还有**别的会话时，
      要真去 `openSession()` 读历史（否则是个"假切换"，时间线还是空的）。
      但 `openSession()` 第一件事就是 `log.innerHTML = ''` ——
      **要是在它 resolve 之前就 addMsg，那条消息会被直接清掉，等于白说一句。**
      ⇒ `applyDeleteResult` 改成 `async`，`await openSession(...)`；顺便让验收脚本
        `await window.__pixelApplyDelete(...)` 能等到历史真的读完再回读时间线。
21. **同一个 token 数在界面上冒出三个值 —— 进制必须跟 pi 一致（÷1000）。**
    老板问的第一句是「上下文怎么只有10万」。查下来数字来自 pi 的模型表第 3 列，
    但**同一个模型在我自己的界面上有三个数**：
      · pi 的表里写 `128K`（`dist/cli/list-models.js` 的 `formatTokenCount` 用 **÷1000**，
        所以它说的 128K 就是 **128000**）；
      · 用量条写 `131.1K`（`fmtTokens` 原来用 ÷1000 但存的是 1024 换算来的 131072）；
      · 配置框写 `131072 词元`（`parseSize` 用 ÷1024）。
    三个数看着像三件事 —— 这种不一致本身就是"这个数哪来的"的成因。
    ⇒ 统一到 **pi 的算法**：`parseSize` / `fmtTokens` 都按 1000。
      另外分母**优先直接显示表里的原话**（`ctxLabel(ci)` 用 `ci.text`），
      这样 pi 写 `1.0M` 我们就显示 `1.0M`，不会自作聪明变成 `1M`。
    ★ 顺带把"这个 128K 是谁定的"查到底了，三条证据都在本机可复现：
      ① `.pi-agent/models.json` 里 `agent-plan/ark-code-latest` **只有** `{"id":"..."}`，
         一个 `contextWindow` 都没声明；
      ② pi 在 `dist/core/provider-composer.js:109` 写死 `contextWindow ?? 128000`；
      ③ 所以 `--list-models` 报 `128K`。
      **不是我们的硬编码**（全库 `grep 100000` 只剩配置上限 `100000000`），
      而是 pi 对"模型自己没声明"的兜底值。
      现在这条链在界面上**可查**（点用量条看明细）**可改**（模型行「配置」填覆盖值）。
22. **「保存成功」的判据不能是"没抛异常" —— 静默丢值比报错危险得多。**
    模型行点「配置」→ 填上下文窗口 → 保存：不报错、还提示了一句，
    但磁盘上 `modelOverrides` **一直是 `{}`**，覆盖值永远不生效。
    真因：`pi:model-set-config` 把整张 `modelOverrides` 表当**配置补丁**传给了
    `applyCfgPatch()`，而它收的是**顶层键**的补丁 —— 白名单一个都匹配不上，
    `Object.assign(cfg, applied)` 等于什么都没写。
    ★★ 最坑的是它**报了一句看着很合理的错**：
      `主进程不认识的键：agent-plan/ark-code-latest`。
      读起来像"键名写错了"，于是会去查键名；真因是**层级错了**。
      ⇒ 错误文案要报**形状**（"这层不该有这些键"），不能只报键名。
    ★ 定位方式（别猜）：`test/probe-mcfg.js` 把四个量**同时**打出来 ——
      值进没进输入框 / `MCFG.sel` 还在不在 / 主进程回了什么 / 磁盘上有没有。
      "保存没生效"至少有四种完全不同的原因，只看最终文件分不出来。
    ★ 顺手删掉 renderer 里一段**看着有用其实没用**的死代码：它自己拼了一份
      `patch` 却从不发送。这种代码比没有更危险 —— 它让"看着在改"显得成立。

### 工具的用法（都是这几轮留下来的）

```bash
npm test                       # 纯逻辑 232 断言 + 文案审计（node，秒级）
npm run verify:features        # 真机 143 断言（必须用 electron）
npm run audit:copy             # 只扫"英文文案残留"（辅助；已挂在 npm test 末尾）

npm run shot:girl              # 欢迎区吉祥物四态截图 + 像素自检（见坑 15）
npm run shot:settings          # 设置面板取证：20 条断言（滚动条 / 标题 / 换行 / Esc / 换皮）+ 截图
npm run shot:model             # 模型框取证：折叠（按行数真变判）+ 配置框排版几何 + Esc + 截图
npm run probe:usage            # 单量：上下文分母到底是多少、从哪来
npm run probe:mcfg             # 单量：模型配置保存卡在哪（四个量一起打）
npm run probe:esc              # 单量：Esc 被哪个浮层接住了
npm run zoom:scene             # 场景里每个元素单独放大 + 打印中心像素值
npm run profile:girl           # 量人物 PNG 的真实轮廓（椅子该多窄这种问题靠它）
npm run probe:scene            # 把四态下各特效的计算样式打出来
npm run zoom:parts             # 按 DOM 选择器自动定位 + 放大截图，肉眼核对
npm run shot:extra             # 全屏截图（含模型面板 / 设置面板）
```

**纯逻辑那一半**（`npm test`，共 232 条）：`fixtures` 46 + `md` 49 + `parse` 20 +
`pal` 54 + `attach` 63。`pal.test.js` 专门盯命令面板的匹配/排序/高亮/参数解析，
末尾带一段**反向验证**（把"子序列匹配"劣化成"字符集合匹配"，
`/nr` 就会误命中 `rename` —— 那几条断言必须因此变红）。

**真机那一半**（`verify:features`，**226 条**）分 10 段：健康检查 / 会话与文件 /
工具栏与交互 / 发图链路 / 删除与导出 / 工具卡片 / Markdown / **中文体检** /
设置·命令面板·命名 / **上下文来源·删空回主页·去 /model·模型配置与折叠**。

`shot:model`（**49 条**）单独盯模型框这类"结构对、视觉错"的东西：分组折叠按**行数真的变**来判
（不是看 class），配置框里 8 个控件**两两不重叠、都在框内**，长文案是换行而不是横向溢出。

**真机验收必须去掉 `ELECTRON_RUN_AS_NODE`**，否则 electron 会被当普通 node 跑，
报 `Cannot read properties of undefined (reading 'handle')`（`ipcMain` 不存在），
**而且是秒退 + 退出码 1** —— 很容易被当成"跑完了、只是有失败项"：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/.bin/electron test/verify-features.js
```

`zoom:parts` 存在的理由：`crop-shot.js` 要手填 `x/y/w/h`，而整屏 1340×880 的图
在对话框里是**缩过**的（`devicePixelRatio = 2`），我手算坐标连试 4 次全打偏。
改成先问 DOM 要 `getBoundingClientRect()` 再 `capturePage(rect)`，坐标永远对得上
—— 而且**只有放大才看得见**的问题（按钮压标题、中文挤压）也就查得动了。

### 配置目录（重要）

PixelAgent **不共用** `~/.pi/agent`，而是用项目下的 `.pi-agent/`：

- 共用会互相抢锁 —— 而且 PixelAgent 一旦被强杀会留下 stale 锁，
  把**终端里的 pi 一起弄坏**。隔离掉，各用各的。
- 首次启动自动从 `~/.pi/agent` 抄 `auth.json` / `models.json` / `settings.json` 过来。
- `.pi-agent/` 里有凭据，**已在 `.gitignore`**，绝不要提交。

会话文件落在 `.sessions/chat-<n>.json`，图片附件落在 `.attachments/`（都在 E 盘）。

### 设置存在哪、有哪些（`.pixelagent.json`，已在 `.gitignore`）

| 键 | 默认 | 作用点（改完是真的会变） |
| --- | --- | --- |
| `workDir` | 项目目录 | pi 的 cwd、`@` 引用、文件树、shell 的 cwd |
| `defaultModel` | `''`（用 pi 默认） | 启动时/改设置时灌进 `curModel`，随每轮请求发给 pi |
| `defaultThinking` | `''`（用 pi 默认） | 同上，走 `--thinking` |
| `enterToSend` | `true` | `true`=Enter 发送（Shift+Enter 换行）；`false`=Enter 换行、Ctrl+Enter 发送 |
| `maxImages` | `4`（1..9） | 附件入队上限（含正在读取的那几张） |
| `accent` | `lav` | 直接改 `--lav` / `--lav-deep` 两个 CSS 变量，整屏换皮 |
| `mascotAnim` | `true` | 关掉 = `body.no-anim`，吉祥物和消息动画全停 |
| `compact` | `false` | `body.compact`：消息行距/内边距收紧 |
| `autoScroll` | `true` | 新消息是否自动滚到底 |
| `exportFormat` | `html` | `/export` 与导出按钮的默认格式（html / md / json **三条都是真实现**） |
| `names` | `{}` | 会话改名记录（别名，不动 pi 的会话文件） |
| `modelOverrides` | `{}` | 单个模型的**用量条分母**覆盖值：`{"provider/model": {contextTokens, maxOut}}`。只影响界面上"百分比算得对不对"，**不改变 pi 实际能收多少上下文**（模型行点「配置」改，见坑 21） |

两条不写成"设置"的：**最近使用的命令**放 `localStorage`（是使用痕迹，不是配置），
**会话改名记录**跟着配置文件走但不算设置项（设置面板不显示它）。
