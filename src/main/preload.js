'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('board', {
  version: () => ipcRenderer.invoke('app:version'),
  listCommands: () => ipcRenderer.invoke('commands:list'),
  reloadCommands: () => ipcRenderer.invoke('commands:reload'),
  preview: (id, values) => ipcRenderer.invoke('commands:preview', id, values),
  saveValues: (id, values) => ipcRenderer.invoke('values:save', id, values),
  start: (id, values, cols, rows) => ipcRenderer.invoke('run:start', id, values, cols, rows),
  stop: (runId, force) => ipcRenderer.invoke('run:stop', runId, !!force),
  confirm: (message, detail, okLabel) => ipcRenderer.invoke('dialog:confirm', message, detail, okLabel),
  input: (runId, data) => ipcRenderer.send('run:input', runId, data),
  resize: (runId, cols, rows) => ipcRenderer.send('run:resize', runId, cols, rows),
  pick: (opts) => ipcRenderer.invoke('dialog:pick', opts),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  pathForFile: (file) => webUtils.getPathForFile(file),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  onData: (fn) => ipcRenderer.on('run:data', (_e, runId, data) => fn(runId, data)),
  onExit: (fn) => ipcRenderer.on('run:exit', (_e, runId, info) => fn(runId, info)),
  onCommandsChanged: (fn) => ipcRenderer.on('commands:changed', () => fn()),
});
