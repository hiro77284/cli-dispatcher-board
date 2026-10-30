'use strict';
/* global Terminal, FitAddon, board */

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c);
  return n;
};
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

const ui = {
  commands: [],
  errors: [],
  dirs: [],
  lastValues: {},
  edited: {}, // コマンドごとの入力中の値
  selectedId: null,
  filtered: [],
  lastPreviewOk: false,
};

// ---------------- 出力タブ ----------------
// 実行ごとにタブを 1 つ作り、それぞれが自分の xterm を持つ。runId → タブ は byRun で引く。
const TERM_OPTS = {
  fontFamily: '"Cascadia Mono", Consolas, "BIZ UDGothic", "MS Gothic", monospace',
  fontSize: 13,
  lineHeight: 1.15,
  scrollback: 20000,
  cursorBlink: true,
  allowProposedApi: true,
  theme: {
    background: '#16171a',
    foreground: '#d7dae0',
    cursor: '#d7dae0',
    selectionBackground: '#3a4a6b',
  },
};
const tabs = [];
const byRun = new Map();
let activeTab = null;
let tabSeq = 0;
const runNo = {}; // コマンドごとの通し番号（同じコマンドのタブを見分ける）

const isRunning = (tab) => tab && tab.runId !== null;
const elapsed = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function tabNo(cmdId) {
  runNo[cmdId] = (runNo[cmdId] || 0) + 1;
  return runNo[cmdId] > 1 ? el('span', { class: 'tab-no', text: `#${runNo[cmdId]}` }) : null;
}

function createTab(cmd, values) {
  const pane = el('div', { class: 'term-pane' });
  $('#term-wrap').append(pane);
  const term = new Terminal(TERM_OPTS);
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(pane);
  const tab = {
    key: ++tabSeq,
    cmdId: cmd.id,
    name: cmd.name,
    values: { ...values },
    runId: null,
    state: 'idle', // idle / running / ok / ng
    startedAt: 0,
    info: null,
    note: '',
    term,
    fit,
    pane,
  };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    // 選択中の Ctrl+C はコピー（選択がなければ Ctrl+C を送ってプロセスに割り込む）
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
      board.copy(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (e.ctrlKey && (e.key === 'Enter' || e.key === 'Tab')) return false;
    return true;
  });
  term.onData((d) => {
    if (isRunning(tab)) board.input(tab.runId, d);
  });
  tab.tabEl = el(
    'div',
    {
      class: 'tab',
      title: cmd.name,
      onclick: () => activateTab(tab),
      onauxclick: (e) => e.button === 1 && closeTab(tab),
    },
    el('span', { class: 'tab-icon' }),
    el('span', { class: 'tab-name', text: cmd.name }),
    tabNo(cmd.id),
    el('button', {
      class: 'tab-close',
      title: '閉じる（中クリックでも閉じます）',
      text: '×',
      onclick: (e) => {
        e.stopPropagation();
        closeTab(tab);
      },
    })
  );
  $('#tabs').append(tab.tabEl);
  tabs.push(tab);
  return tab;
}

function renderTab(tab) {
  tab.tabEl.className = `tab ${tab.state}${tab === activeTab ? ' active' : ''}`;
  const icon = { idle: '', running: '●', ok: '✔', ng: '✖' }[tab.state];
  tab.tabEl.querySelector('.tab-icon').textContent = icon;
}

function refitActive() {
  const tab = activeTab;
  if (!tab) return;
  try {
    tab.fit.fit();
    if (isRunning(tab)) board.resize(tab.runId, tab.term.cols, tab.term.rows);
  } catch {
    /* 非表示のときは失敗する */
  }
}
new ResizeObserver(debounce(refitActive, 50)).observe($('#term-wrap'));

function activateTab(tab, focus = true) {
  activeTab = tab;
  for (const t of tabs) {
    t.pane.classList.toggle('active', t === tab);
    renderTab(t);
  }
  $('#term-empty').hidden = tabs.length > 0;
  if (tab) {
    refitActive();
    if (focus) tab.term.focus();
    tab.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  renderStatus();
  updateRunButtons();
}

function removeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  if (tab.runId !== null) byRun.delete(tab.runId);
  tab.term.dispose();
  tab.pane.remove();
  tab.tabEl.remove();
  tabs.splice(i, 1);
  if (activeTab === tab) activateTab(tabs[i] || tabs[i - 1] || null, false);
  else activateTab(activeTab, false);
  renderList();
}

async function closeTab(tab) {
  if (isRunning(tab)) {
    const ok = await board.confirm('このタブのコマンドは実行中です。止めて閉じますか？', tab.name, '止めて閉じる');
    if (!ok) return;
    if (isRunning(tab)) board.stop(tab.runId, true);
  }
  removeTab(tab);
}

function closeFinishedTabs() {
  for (const t of [...tabs]) if (!isRunning(t)) removeTab(t);
}

function cycleTab(delta) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(activeTab);
  activateTab(tabs[(i + delta + tabs.length) % tabs.length]);
}

// タブでコマンドを実行する（新しいタブでも、終わったタブの再実行でも使う）
async function startInTab(tab, cmd, values) {
  refitActive();
  const r = await board.start(cmd.id, values, tab.term.cols, tab.term.rows);
  if (r.cancelled) return r;
  tab.values = { ...values };
  if (r.error) {
    tab.term.write(`\r\n\x1b[31m✖ ${r.error.replace(/\n/g, '\r\n  ')}\x1b[0m\r\n`);
    tab.state = 'ng';
    tab.info = null;
    tab.note = '実行できませんでした';
    renderTab(tab);
    if (tab === activeTab) renderStatus();
    return r;
  }
  const time = new Date(r.startedAt).toLocaleTimeString('ja-JP');
  tab.term.write(`\x1b[36m━━ ${time}  ${cmd.name}\x1b[0m\r\n\x1b[90m> ${r.display}\r\n  （作業フォルダ: ${r.cwd}）\x1b[0m\r\n`);
  tab.runId = r.runId;
  tab.startedAt = r.startedAt;
  tab.state = 'running';
  tab.note = '';
  tab.info = null;
  byRun.set(r.runId, tab);
  renderTab(tab);
  renderList();
  if (tab === activeTab) {
    renderStatus();
    updateRunButtons();
  }
  return r;
}

board.onData((runId, data) => {
  byRun.get(runId)?.term.write(data);
});

board.onExit((runId, info) => {
  const tab = byRun.get(runId);
  byRun.delete(runId);
  if (!tab) return;
  tab.runId = null;
  tab.info = info;
  tab.note = '';
  const ok = info.exitCode === 0 && !info.signal;
  tab.state = ok ? 'ok' : 'ng';
  const sec = (info.durationMs / 1000).toFixed(1);
  tab.term.write(
    `\r\n\x1b[${ok ? '32' : '31'}m${ok ? '✔' : '✖'} 終了コード ${info.exitCode}${info.signal ? `（シグナル ${info.signal}）` : ''}  ${sec} 秒\x1b[0m\r\n\r\n`
  );
  renderTab(tab);
  renderList();
  if (tab === activeTab) {
    renderStatus();
    updateRunButtons();
  }
});

// 実行中タブの経過時間を更新する
setInterval(() => {
  if (isRunning(activeTab)) renderStatus();
}, 500);

// ---------------- 一覧 ----------------
function matches(c, q) {
  if (!q) return true;
  const hay = [c.name, c.id, c.category, c.description, c.program, ...(c.tags || [])].join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function runningBadge(cmdId) {
  const n = tabs.filter((t) => t.cmdId === cmdId && isRunning(t)).length;
  return n ? el('span', { class: 'badge', title: '実行中', text: n > 1 ? `実行中 ${n}` : '実行中' }) : null;
}

function renderList() {
  const q = $('#search').value.trim();
  ui.filtered = ui.commands.filter((c) => matches(c, q));
  const groups = new Map();
  for (const c of ui.filtered) {
    if (!groups.has(c.category)) groups.set(c.category, []);
    groups.get(c.category).push(c);
  }
  const list = $('#list');
  list.replaceChildren();
  if (ui.filtered.length === 0) {
    list.append(el('div', { class: 'list-empty', text: q ? '一致するコマンドはありません' : 'コマンドが登録されていません' }));
  }
  for (const [cat, items] of groups) {
    list.append(el('div', { class: 'group', text: cat }));
    for (const c of items) {
      list.append(
        el(
          'button',
          {
            class: 'item' + (c.id === ui.selectedId ? ' selected' : ''),
            'data-id': c.id,
            title: c.description || c.name,
            onclick: () => selectCommand(c.id),
          },
          el('span', { class: 'item-name' }, c.name, runningBadge(c.id)),
          el('span', { class: 'item-prog', text: c.program })
        )
      );
    }
  }
  // 読み込みエラー
  const box = $('#load-errors');
  box.hidden = ui.errors.length === 0;
  box.replaceChildren(
    el('div', { class: 'err-title', text: `定義の読み込みエラー ${ui.errors.length} 件` }),
    ...ui.errors.map((er) =>
      el(
        'button',
        { class: 'err-item', title: 'クリックでファイルを開く', onclick: () => board.open(er.file) },
        el('b', { text: er.file.split(/[\\/]/).pop() }),
        el('span', { text: er.message })
      )
    )
  );
}

function moveSelection(delta) {
  if (ui.filtered.length === 0) return;
  let i = ui.filtered.findIndex((c) => c.id === ui.selectedId);
  i = i < 0 ? 0 : Math.min(ui.filtered.length - 1, Math.max(0, i + delta));
  selectCommand(ui.filtered[i].id);
  document.querySelector(`.item[data-id="${CSS.escape(ui.filtered[i].id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---------------- 詳細とフォーム ----------------
const current = () => ui.commands.find((c) => c.id === ui.selectedId);

function defaultsOf(c) {
  const v = {};
  for (const p of c.params) v[p.name] = p.type === 'flag' ? !!p.default : p.default ?? '';
  return v;
}

function valuesOf(c) {
  if (!ui.edited[c.id]) {
    const saved = ui.lastValues[c.id] || {};
    const v = defaultsOf(c);
    for (const p of c.params) if (Object.prototype.hasOwnProperty.call(saved, p.name)) v[p.name] = saved[p.name];
    ui.edited[c.id] = v;
  }
  return ui.edited[c.id];
}

function selectCommand(id) {
  ui.selectedId = id;
  renderList();
  renderDetail();
}

function renderDetail() {
  const c = current();
  $('#empty').hidden = !!c;
  $('#detail').hidden = !c;
  $('#runbar').hidden = !c;
  if (!c) return;
  $('#cmd-category').textContent = c.category;
  $('#cmd-name').textContent = c.name;
  $('#cmd-desc').textContent = c.description || '';
  $('#cmd-desc').hidden = !c.description;
  renderForm(c);
  updatePreview();
}

const savedLater = debounce((id, v) => board.saveValues(id, v), 600);

function onValue(c, name, value) {
  valuesOf(c)[name] = value;
  savedLater(c.id, { ...valuesOf(c) });
  updatePreview();
}

function control(c, p, v) {
  const id = `f-${p.name}`;
  const set = (val) => onValue(c, p.name, val);
  switch (p.type) {
    case 'flag': {
      const box = el('input', { type: 'checkbox', id, checked: !!v, onchange: (e) => set(e.target.checked) });
      return el('label', { class: 'check' }, box, el('span', { text: p.description ? '' : '有効にする' }));
    }
    case 'select': {
      if (p.allowCustom) {
        const listId = `${id}-list`;
        return el(
          'div',
          {},
          el('input', { type: 'text', id, list: listId, value: v ?? '', placeholder: p.placeholder, oninput: (e) => set(e.target.value) }),
          el('datalist', { id: listId }, ...p.options.map((o) => el('option', { value: o.value, text: o.label })))
        );
      }
      const sel = el(
        'select',
        { id, onchange: (e) => set(e.target.value) },
        ...p.options.map((o) => el('option', { value: o.value, text: o.label, selected: String(o.value) === String(v ?? '') }))
      );
      return sel;
    }
    case 'file':
    case 'folder': {
      const input = el('input', {
        type: 'text',
        id,
        value: v ?? '',
        placeholder: p.placeholder || (p.type === 'folder' ? 'フォルダのパス（ドロップも可）' : 'ファイルのパス（ドロップも可）'),
        oninput: (e) => set(e.target.value),
      });
      const btn = el('button', {
        type: 'button',
        class: 'ghost',
        text: '参照…',
        onclick: async () => {
          const r = await board.pick({ type: p.type, save: p.save, filters: p.filters, defaultPath: input.value });
          if (r) {
            input.value = r;
            set(r);
          }
        },
      });
      return el('div', { class: 'path-row' }, input, btn);
    }
    case 'number':
      return el('input', {
        type: 'text',
        inputmode: 'numeric',
        id,
        class: 'num',
        value: v ?? '',
        placeholder: p.placeholder,
        oninput: (e) => set(e.target.value),
      });
    default:
      return el('input', { type: 'text', id, value: v ?? '', placeholder: p.placeholder, oninput: (e) => set(e.target.value) });
  }
}

function renderForm(c) {
  const form = $('#form');
  form.replaceChildren();
  if (c.params.length === 0) {
    form.append(el('div', { class: 'no-params', text: 'このコマンドには入力するパラメータがありません。' }));
    return;
  }
  const v = valuesOf(c);
  for (const p of c.params) {
    form.append(
      el(
        'div',
        { class: 'field' },
        el('label', { for: `f-${p.name}`, class: 'field-label' }, p.label, p.required ? el('span', { class: 'req', text: ' *' }) : null),
        el('div', { class: 'field-body' }, control(c, p, v[p.name]), p.description ? el('div', { class: 'help', text: p.description }) : null)
      )
    );
  }
}

// ファイルをフォームの入力欄にドロップしたらパスを入れる
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const input = e.target.closest?.('input[type="text"]');
  const f = e.dataTransfer?.files?.[0];
  if (!input || !f) return;
  const p = board.pathForFile(f);
  if (!p) return;
  input.value = p;
  input.dispatchEvent(new Event('input'));
});

// ---------------- プレビューと実行 ----------------
let previewSeq = 0;
async function updatePreview() {
  const c = current();
  if (!c) return;
  const seq = ++previewSeq;
  const r = await board.preview(c.id, valuesOf(c));
  if (seq !== previewSeq) return;
  $('#preview').textContent = r.display || '（組み立てられません）';
  $('#preview').title = r.cwd ? `作業フォルダ: ${r.cwd}` : '組み立てたコマンドライン';
  ui.lastPreviewOk = r.ok;
  $('#validation').replaceChildren(...r.errors.map((m) => el('div', { text: m })));
  updateRunButtons();
}

function updateRunButtons() {
  const tab = activeTab;
  $('#run').disabled = !ui.lastPreviewOk;
  $('#stop').disabled = !isRunning(tab);
  $('#rerun').disabled = !tab || isRunning(tab) || !ui.commands.some((c) => c.id === tab.cmdId);
  $('#clear').disabled = !tab;
  $('#close-done').disabled = !tabs.some((t) => !isRunning(t));
}

function setStatus(text, kind = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

// 状態欄には、選んでいるタブの状態を出す
function renderStatus() {
  const tab = activeTab;
  const running = tabs.filter(isRunning).length;
  const others = running - (isRunning(tab) ? 1 : 0);
  const tail = others > 0 ? `　｜　ほかに実行中 ${others} 件` : '';
  if (!tab) return setStatus(running ? `実行中 ${running} 件` : '');
  if (isRunning(tab)) return setStatus(`${tab.note || '実行中…'} ${elapsed(Date.now() - tab.startedAt)}${tail}`, 'running');
  if (tab.info) {
    const sec = (tab.info.durationMs / 1000).toFixed(1);
    const sig = tab.info.signal ? `・シグナル ${tab.info.signal}` : '';
    return setStatus(`終了コード ${tab.info.exitCode}（${sec} 秒${sig}）${tail}`, tab.state);
  }
  return setStatus(`${tab.note}${tail}`, tab.state === 'ng' ? 'ng' : '');
}

// 実行するたびに新しいタブを開く
async function runCurrent() {
  const c = current();
  if (!c || !ui.lastPreviewOk) return;
  const tab = createTab(c, valuesOf(c));
  activateTab(tab);
  const r = await startInTab(tab, c, valuesOf(c));
  if (r.cancelled) removeTab(tab);
}

async function rerunActive() {
  const tab = activeTab;
  if (!tab || isRunning(tab)) return;
  const c = ui.commands.find((x) => x.id === tab.cmdId);
  if (!c) return;
  await startInTab(tab, c, tab.values);
}

$('#run').addEventListener('click', runCurrent);
$('#rerun').addEventListener('click', rerunActive);
$('#stop').addEventListener('click', async () => {
  const tab = activeTab;
  if (!isRunning(tab)) return;
  const r = await board.stop(tab.runId);
  if (!isRunning(tab)) return;
  if (r === 'interrupt') tab.note = '停止しています…（もう一度押すと強制終了）';
  else if (r === 'force') tab.note = '強制終了しています…';
  renderStatus();
});
$('#clear').addEventListener('click', () => activeTab && activeTab.term.clear());
$('#close-done').addEventListener('click', closeFinishedTabs);
$('#copy').addEventListener('click', () => {
  board.copy($('#preview').textContent);
  setStatus('コマンドラインをコピーしました');
});
$('#reset-values').addEventListener('click', () => {
  const c = current();
  if (!c) return;
  ui.edited[c.id] = defaultsOf(c);
  board.saveValues(c.id, { ...ui.edited[c.id] });
  renderDetail();
});
$('#open-def').addEventListener('click', () => current() && board.open(current().file));
$('#open-dir').addEventListener('click', () => ui.dirs[0] && board.open(ui.dirs[0]));
$('#reload').addEventListener('click', async () => {
  await board.reloadCommands();
  await loadCommands();
});

$('#search').addEventListener('input', () => renderList());
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (!current() || !ui.filtered.includes(current())) moveSelection(0);
    document.querySelector('#form input, #form select')?.focus();
  } else if (e.key === 'Escape') {
    e.target.value = '';
    renderList();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    runCurrent();
  } else if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault();
    cycleTab(e.shiftKey ? -1 : 1);
  } else if (e.ctrlKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#search').focus();
    $('#search').select();
  }
});

// 上下の境目をドラッグして高さを変える
(() => {
  const split = $('#splitter');
  const main = $('#main');
  let startY = 0;
  let startH = 0;
  const onMove = (e) => {
    const h = Math.max(120, Math.min(main.clientHeight - 200, startH + e.clientY - startY));
    main.style.setProperty('--top-h', `${h}px`);
  };
  split.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startH = $('#top').getBoundingClientRect().height;
    document.body.classList.add('dragging');
    window.addEventListener('mousemove', onMove);
    window.addEventListener(
      'mouseup',
      () => {
        document.body.classList.remove('dragging');
        window.removeEventListener('mousemove', onMove);
        refitActive();
      },
      { once: true }
    );
  });
})();

// ---------------- 起動 ----------------
async function loadCommands() {
  const r = await board.listCommands();
  ui.commands = r.commands;
  ui.errors = r.errors;
  ui.dirs = r.dirs;
  ui.lastValues = r.lastValues || {};
  // 定義が変わったコマンドの入力中の値は、存在するパラメータだけ残す
  for (const c of ui.commands) {
    const v = ui.edited[c.id];
    if (!v) continue;
    const next = defaultsOf(c);
    for (const p of c.params) if (Object.prototype.hasOwnProperty.call(v, p.name)) next[p.name] = v[p.name];
    ui.edited[c.id] = next;
  }
  if (ui.selectedId && !current()) ui.selectedId = null;
  renderList();
  renderDetail();
}

board.onCommandsChanged(() => loadCommands());
loadCommands().then(() => {
  activateTab(null, false);
  $('#search').focus();
});
