// ============================================================
// preload.js —— 桥梁：给界面开一个安全的 window.pixelAPI
// 界面（renderer.js）只能通过它跟主进程说话，拿不到 Node 权限。
// ============================================================
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('pixelAPI', {
  // 发一轮话：payload 可以是字符串，也可以是 {text, images:[{name,dataUrl}]}
  ask: (payload) => ipcRenderer.invoke('pi:ask', payload),
  // 停止当前这一轮
  abort: () => ipcRenderer.invoke('pi:abort'),

  // 会话
  newSession: () => ipcRenderer.invoke('pi:new-session'),
  sessions: () => ipcRenderer.invoke('pi:sessions'),
  openSession: (seq) => ipcRenderer.invoke('pi:open-session', seq),
  history: (seq) => ipcRenderer.invoke('pi:session-history', seq),
  renameSession: (seq, name) => ipcRenderer.invoke('pi:session-rename', seq, name),
  deleteSession: (seq) => ipcRenderer.invoke('pi:session-delete', seq),
  exportSession: (seq, outPath, fmt) => ipcRenderer.invoke('pi:session-export', seq, outPath, fmt),

  // 跨会话搜索
  search: (q) => ipcRenderer.invoke('pi:search', q),

  // 文件树 / 工作目录
  files: (dir) => ipcRenderer.invoke('pi:files', dir),
  // 老板 2026-10-12：拖 .html 进窗口时浏览器只给 file:// 路径、不给 File 对象，
  // 用这个 IPC 补 name/size/mime，再走同一套附件把关
  statFile: (p) => ipcRenderer.invoke('pi:stat-file', p),

  // ★ 老板 2026-10-12 23:5x「为什么不能直接把文件拖进去」——根因：Electron 32+ 删掉了
  // 非标准属性 File.path，非图片附件（PDF 等）恒拿不到磁盘路径，全被那句
  // 「这份文件拿不到磁盘路径」挡下。官方替代是 webUtils.getPathForFile（同步）。
  // 实测：真实落盘文件（拖拽/点选）经 contextBridge 传进来仍能拿回真路径；
  // 虚拟文件（微信/QQ/网页里拖出来的，只有内容没有后端）返回 '' —— 那种走 saveFile 退路。
  pathForFile: (f) => {
    try { return webUtils.getPathForFile(f) || ''; } catch (e) { return ''; }
  },
  // 虚拟文件的退路：内容交给主进程落进附件目录，回来就有一个普通路径附件了。
  // 传 Uint8Array（结构化克隆）而不是 base64 —— 大文件少一层 33% 膨胀和字符串转换。
  saveFile: (payload) => ipcRenderer.invoke('pi:save-file', payload),
  pickDir: () => ipcRenderer.invoke('pi:pick-dir'),
  setWorkDir: (dir) => ipcRenderer.invoke('pi:set-workdir', dir),

  // `!` 直接执行 shell
  runShell: (payload) => ipcRenderer.invoke('pi:run-shell', payload),
  killShell: (id) => ipcRenderer.invoke('pi:shell-kill', id),

  // 模型 / 思考档位
  models: () => ipcRenderer.invoke('pi:models'),
  setModel: (sel) => ipcRenderer.invoke('pi:set-model', sel),
  setThinking: (level) => ipcRenderer.invoke('pi:set-thinking', level),
  // 单个模型：查它是什么（声明值 / pi 报的值 / 我们的覆盖）、覆盖它、真跑一次测通
  modelInfo: (sel) => ipcRenderer.invoke('pi:model-info', sel),
  setModelConfig: (sel) => ipcRenderer.invoke('pi:model-set-config', sel),
  modelTest: (sel) => ipcRenderer.invoke('pi:model-test', sel),
  // 老板 2026-10-11：新增自定义模型
  addModel: (p) => ipcRenderer.invoke('pi:add-model', p),
  // 老板 2026-10-12：新增模型时服务商返回的所有模型整组入组（不再是只加选中的那个）
  addModels: (p) => ipcRenderer.invoke('pi:add-models', p),
  // 老板 2026-10-11 17:44：新增模型时按 base/key 直接拉 provider 支持的模型清单
  fetchProviderModels: (p) => ipcRenderer.invoke('pi:fetch-provider-models', p),
  // 老板 2026-10-11 17:44：新增模型时发一次 max_tokens=1 的最小请求验证连通
  testConnection: (p) => ipcRenderer.invoke('pi:test-connection', p),

  // 扩展清单
  agents: () => ipcRenderer.invoke('pi:agents'),
  // 启动时自动检查扩展更新（npm outdated 纯比对，不真更新）；force=true 绕过缓存
  checkUpdates: (force) => ipcRenderer.invoke('pi:check-updates', { force: !!force }),
  // 删除模型组（右键分组标题 → 确认窗 → 删 providers.<组名> 整键）
  removeModelGroup: (provider) => ipcRenderer.invoke('pi:remove-model-group', { provider }),
  // 更新 pi 本体 / 扩展（老板 2026-10-11：PI 的更新直接在 PixelAgent 里做）
  updatePi: (what) => ipcRenderer.invoke('pi:update', what || {}),

  // 读信息（模型/会话路径/配置目录），设置面板用
  info: () => ipcRenderer.invoke('pi:info'),

  // 应用自身的更新检查（GitHub Release 比对版本号）+ 打开下载页
  // force=true 绕过主进程缓存 —— 渲染层周期复检用（启动没网时缓存里是 ok:false）
  checkAppUpdate: (force) => ipcRenderer.invoke('app:check-update', { force: !!force }),
  openUpdatePage: () => ipcRenderer.invoke('app:open-update-page'),

  // 老板 2026-10-13：「还要有桌面提醒功能」—— 系统级 Notification。
  // 渲染层不直接 new Notification（contextIsolation 没权限），走这条 IPC。
  // 什么时候发由渲染层决定（默认只在窗口不在前台时发，见 CFG.desktopNotify）。
  notify: (title, body) => ipcRenderer.invoke('app:notify', { title, body }),

  // 老板 2026-10-13：「我让她自己扫描自己，发现很多的缺失」+「精装房」——
  // 自我扫描体检：模型配置/运行时/扩展/目录可写/工作目录/网络，逐项给修复指引。
  doctor: () => ipcRenderer.invoke('pi:doctor'),

  // 后台任务快照（右上角「智能体」栏用）：主进程起落点登记，
  // 每次变动也会主动推 {kind:'bg'} 过来，这里只是启动时补一次的快照口。
  bgTasks: () => ipcRenderer.invoke('pi:bg-tasks'),

  // 设置：读 / 写 / 恢复默认
  cfg: () => ipcRenderer.invoke('pi:cfg'),
  setCfg: (patch) => ipcRenderer.invoke('pi:cfg-set', patch),
  resetCfg: () => ipcRenderer.invoke('pi:cfg-reset'),

  // 窗口控制（无原生标题栏后，按钮自己发号施令）
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),

  // 收主进程推过来的所有消息
  onMsg: (cb) => {
    ipcRenderer.on('pi:msg', (_e, data) => cb(data));
  }
});
