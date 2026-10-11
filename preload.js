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
  exportSession: (seq, outPath) => ipcRenderer.invoke('pi:session-export', seq, outPath),

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

  // 扩展清单
  agents: () => ipcRenderer.invoke('pi:agents'),

  // 读信息（模型/会话路径/配置目录），设置面板用
  info: () => ipcRenderer.invoke('pi:info'),

  // 窗口控制（无原生标题栏后，按钮自己发号施令）
  winMin: () => ipcRenderer.invoke('win:min'),
  winMax: () => ipcRenderer.invoke('win:max'),
  winClose: () => ipcRenderer.invoke('win:close'),

  // 收主进程推过来的所有消息
  onMsg: (cb) => {
    ipcRenderer.on('pi:msg', (_e, data) => cb(data));
  }
});
