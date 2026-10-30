'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const pty = require('node-pty');
const { loadCommands } = require('./commands');
const { buildCommand } = require('./build');
const { planSpawn } = require('./runner');

let win = null;
let catalog = { commands: [], errors: [] };
const runs = new Map(); // 実行中のプロセス runId → { id, proc, startedAt, cmdId }
let runSeq = 0;

// ---- 保存する状態（前回の入力値・設定） ----
const statePath = () => path.join(app.getPath('userData'), 'state.json');
let state = { lastValues: {}, settings: { commandsDirs: [] } };

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    state = { lastValues: s.lastValues || {}, settings: { commandsDirs: [], ...(s.settings || {}) } };
  } catch {
    /* 初回は無い */
  }
}

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
  }, 300);
}

// 定義フォルダ：設定にあればそれ、なければアプリ同梱の commands
function commandsDirs() {
  // 環境変数 CLI_BOARD_COMMANDS（; 区切り）があれば最優先（開発・検証用）
  if (process.env.CLI_BOARD_COMMANDS) return process.env.CLI_BOARD_COMMANDS.split(path.delimiter).filter(Boolean);
  const dirs = state.settings.commandsDirs.filter((d) => d && fs.existsSync(d));
  return dirs.length ? dirs : [path.join(app.getAppPath(), 'commands')];
}

function reloadCatalog() {
  catalog = loadCommands(commandsDirs());
  return catalog;
}

function findCommand(id) {
  return catalog.commands.find((c) => c.id === id);
}

// 定義ファイルが変わったら自動で読み直す
const watchers = [];
function watchCommandDirs() {
  watchers.splice(0).forEach((w) => w.close());
  let timer = null;
  for (const dir of commandsDirs()) {
    try {
      watchers.push(
        fs.watch(dir, { recursive: true }, () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            reloadCatalog();
            win?.webContents.send('commands:changed');
          }, 300);
        })
      );
    } catch {
      /* 監視できない環境では手動の再読込だけ */
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    title: `CLI ディスパッチャーボード v${app.getVersion()}`,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // 実行中のコマンドがあれば、止めて閉じてよいか確かめる
  let closingConfirmed = false;
  win.on('close', (e) => {
    if (closingConfirmed || runs.size === 0) return;
    e.preventDefault();
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['止めて終了する', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: `実行中のコマンドが ${runs.size} 件あります。`,
      detail: '終了すると、実行中のコマンドはすべて強制終了します。',
    });
    if (r === 0) {
      closingConfirmed = true;
      killAll();
      win.close();
    }
  });
  win.on('closed', () => {
    win = null;
  });
}

// ---- IPC ----
function publicCommand(c) {
  const { args, env, ...rest } = c;
  return rest;
}

ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('commands:list', () => ({
  commands: catalog.commands.map(publicCommand),
  errors: catalog.errors,
  dirs: commandsDirs(),
  lastValues: state.lastValues,
}));

ipcMain.handle('commands:reload', () => {
  reloadCatalog();
  return true;
});

ipcMain.handle('commands:preview', (_e, id, values) => {
  const c = findCommand(id);
  if (!c) return { ok: false, errors: ['コマンドが見つかりません'], display: '' };
  const b = buildCommand(c, values);
  return { ok: b.ok, errors: b.errors, display: b.display, cwd: b.cwd };
});

ipcMain.handle('values:save', (_e, id, values) => {
  state.lastValues[id] = values;
  saveState();
});

ipcMain.handle('run:start', async (_e, id, values, cols, rows) => {
  const c = findCommand(id);
  if (!c) return { error: 'コマンドが見つかりません' };
  const built = buildCommand(c, values);
  if (!built.ok) return { error: built.errors.join('\n') };
  if (c.confirm) {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['実行する', 'やめる'],
      defaultId: 1,
      cancelId: 1,
      message: c.confirm,
      detail: built.display,
    });
    if (r.response !== 0) return { cancelled: true };
  }
  if (built.cwd && !fs.existsSync(built.cwd)) return { error: `作業フォルダがありません: ${built.cwd}` };
  const plan = planSpawn(built, { defaultCwd: app.getPath('home') });
  if (plan.error) return { error: plan.error };

  state.lastValues[id] = built.values;
  saveState();

  let proc;
  try {
    proc = pty.spawn(plan.file, plan.args, {
      name: 'xterm-256color',
      cols: Math.max(20, cols | 0) || 120,
      rows: Math.max(5, rows | 0) || 30,
      cwd: plan.cwd,
      env: plan.env,
    });
  } catch (e) {
    return { error: `起動できませんでした: ${e.message}` };
  }
  const runId = ++runSeq;
  const startedAt = Date.now();
  const run = { id: runId, proc, startedAt, cmdId: id };
  runs.set(runId, run);

  // 細かい出力を少しまとめて送る（描画の負荷を下げる）
  let buf = '';
  let flushTimer = null;
  const flush = () => {
    flushTimer = null;
    if (buf && win) win.webContents.send('run:data', runId, buf);
    buf = '';
  };
  proc.onData((d) => {
    buf += d;
    if (buf.length > 64 * 1024) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 16);
  });
  proc.onExit(({ exitCode, signal }) => {
    clearTimeout(flushTimer);
    flush();
    clearTimeout(run.stopTimer);
    clearTimeout(run.lastResort);
    runs.delete(runId);
    win?.webContents.send('run:exit', runId, { exitCode, signal, durationMs: Date.now() - startedAt });
  });
  return { runId, display: built.display, cwd: plan.cwd, startedAt };
});

ipcMain.on('run:input', (_e, runId, data) => {
  runs.get(runId)?.proc.write(data);
});

ipcMain.on('run:resize', (_e, runId, cols, rows) => {
  const run = runs.get(runId);
  if (run && cols > 0 && rows > 0) {
    try {
      run.proc.resize(cols, rows);
    } catch {
      /* 終了直後は失敗することがある */
    }
  }
});

// 停止：まず Ctrl+C を送って行儀よく終わらせ、2 秒で終わらなければ強制終了する。
// node-pty の kill() は Windows（ConPTY）で、子プロセス一覧を取りに行く補助プロセスが
// 「AttachConsole failed」で落ちる（終了と競合する）ため、強制終了は taskkill /T でプロセスツリーごと行い、
// kill() はそれでも終わらないときの最後の手段にする。
function killTree(pid, sync = false) {
  try {
    if (process.platform === 'win32') {
      const args = ['/T', '/F', '/PID', String(pid)];
      if (sync) execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      else execFile('taskkill', args, { windowsHide: true }, () => {});
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* すでに終了 */
  }
}

function forceKill(run) {
  if (!run || run.forced) return;
  run.forced = true;
  clearTimeout(run.stopTimer);
  killTree(run.proc.pid);
  run.lastResort = setTimeout(() => {
    if (runs.get(run.id) === run) {
      try {
        run.proc.kill();
      } catch {
        /* すでに終了 */
      }
    }
  }, 3000);
}

// force: true なら Ctrl+C を飛ばしてすぐ強制終了（タブを閉じるときなど）
ipcMain.handle('run:stop', (_e, runId, force = false) => {
  const run = runs.get(runId);
  if (!run) return null;
  if (run.stopping || force) {
    forceKill(run);
    return 'force';
  }
  run.stopping = true;
  try {
    run.proc.write('\x03');
  } catch {
    /* 書けなければ強制終了へ */
  }
  run.stopTimer = setTimeout(() => forceKill(run), 2000);
  return 'interrupt';
});

ipcMain.handle('dialog:confirm', async (_e, message, detail, okLabel = 'OK') => {
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [okLabel, 'キャンセル'],
    defaultId: 0,
    cancelId: 1,
    message,
    detail: detail || undefined,
  });
  return r.response === 0;
});

ipcMain.handle('dialog:pick', async (_e, opts) => {
  const filters = [...(opts.filters || []), { name: 'すべてのファイル', extensions: ['*'] }];
  if (opts.type === 'folder') {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: opts.defaultPath || undefined });
    return r.canceled ? null : r.filePaths[0];
  }
  if (opts.save) {
    const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath || undefined, filters });
    return r.canceled ? null : r.filePath;
  }
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], defaultPath: opts.defaultPath || undefined, filters });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('shell:open', (_e, target) => shell.openPath(target));
ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)));

app.whenReady().then(() => {
  loadState();
  reloadCatalog();
  watchCommandDirs();
  createWindow();
});

function killAll() {
  for (const run of runs.values()) killTree(run.proc.pid, true);
  runs.clear();
}

app.on('window-all-closed', () => {
  killAll();
  app.quit();
});
