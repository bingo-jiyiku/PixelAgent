// ============================================================
// preload.js —— 桥梁：给界面开一个安全的 window.pixelAPI
// 界面（renderer.js）只能通过它跟主进程说话，拿不到 Node 权限。
// ============================================================
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pixelAPI', {
  // 发一轮话
  ask: (text) => ipcRenderer.invoke('pi:ask', text),
  // 停止当前这一轮
  abort: () => ipcRenderer.invoke('pi:abort'),
  // 开新会话
  newSession: () => ipcRenderer.invoke('pi:new-session'),
  // 读信息（模型/会话路径），设置面板用
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
