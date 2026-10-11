// ============================================================
// preload.js —— 桥梁：给界面开一个安全的 window.pixelAPI
// 界面（renderer.js）只能通过它跟主进程说话，拿不到 Node 权限。
// ============================================================
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
  // 老板 2026-10-11 17:44：新增模型时按 base/key 直接拉 provider 支持的模型清单
  fetchProviderModels: (p) => ipcRenderer.invoke('pi:fetch-provider-models', p),
  // 老板 2026-10-11 17:44：新增模型时发一次 max_tokens=1 的最小请求验证连通
  testConnection: (p) => ipcRenderer.invoke('pi:test-connection', p),

  // 扩展清单
  agents: () => ipcRenderer.invoke('pi:agents'),

  // 读信息（模型/会话路径/配置目录），设置面板用
  info: () => ipcRenderer.invoke('pi:info'),

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
