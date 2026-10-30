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
  run: null, // { runId, startedAt, timer }
  lastPreviewOk: false,
};

// ---------------- ターミナル ----------------
const term = new Terminal({
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
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.open($('#terminal'));
term.writeln('\x1b[90mここに実行結果が表示されます。実行中はこの画面に直接キー入力できます（y/n の確認など）。\x1b[0m');

term.attachCustomKeyEventHandler((e) => {
  if (e.type !== 'keydown') return true;
  // 選択中の Ctrl+C はコピー（選択がなければ Ctrl+C を送ってプロセスに割り込む）
  if (e.ctrlKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
    board.copy(term.getSelection());
    term.clearSelection();
    return false;
  }
  if (e.ctrlKey && e.key === 'Enter') return false;
  return true;
});
term.onData((d) => {
  if (ui.run) board.input(ui.run.runId, d);
});

const refit = () => {
  try {
    fit.fit();
    board.resize(term.cols, term.rows);
  } catch {
    /* 非表示のときは失敗する */
  }
};
new ResizeObserver(debounce(refit, 50)).observe($('#term-wrap'));

board.onData((runId, data) => {
  if (ui.run && ui.run.runId === runId) term.write(data);
});

board.onExit((runId, info) => {
  if (!ui.run || ui.run.runId !== runId) return;
  clearInterval(ui.run.timer);
  ui.run = null;
  const sec = (info.durationMs / 1000).toFixed(1);
  const ok = info.exitCode === 0;
  term.write(
    `\r\n\x1b[${ok ? '32' : '31'}m${ok ? '✔' : '✖'} 終了コード ${info.exitCode}${info.signal ? `（シグナル ${info.signal}）` : ''}  ${sec} 秒\x1b[0m\r\n`
  );
  setStatus(`終了コード ${info.exitCode}（${sec} 秒）`, ok ? 'ok' : 'ng');
  updateRunButtons();
});

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
          el('span', { class: 'item-name', text: c.name }),
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
  $('#run').disabled = !!ui.run || !ui.lastPreviewOk;
  $('#stop').disabled = !ui.run;
  $('#sidebar').classList.toggle('busy', !!ui.run);
}

function setStatus(text, kind = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = `status ${kind}`;
}

async function runCurrent() {
  const c = current();
  if (!c || ui.run || !ui.lastPreviewOk) return;
  refit();
  const r = await board.start(c.id, valuesOf(c), term.cols, term.rows);
  if (r.cancelled) return;
  if (r.error) {
    term.write(`\r\n\x1b[31m✖ ${r.error.replace(/\n/g, '\r\n  ')}\x1b[0m\r\n`);
    setStatus('実行できませんでした', 'ng');
    return;
  }
  const time = new Date(r.startedAt).toLocaleTimeString('ja-JP');
  term.write(`\r\n\x1b[36m━━ ${time}  ${c.name}\x1b[0m\r\n\x1b[90m> ${r.display}\r\n  （作業フォルダ: ${r.cwd}）\x1b[0m\r\n`);
  ui.run = { runId: r.runId, startedAt: r.startedAt };
  const tick = () => {
    const s = Math.floor((Date.now() - r.startedAt) / 1000);
    setStatus(`実行中… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, 'running');
  };
  tick();
  ui.run.timer = setInterval(tick, 500);
  updateRunButtons();
  term.focus();
}

$('#run').addEventListener('click', runCurrent);
$('#stop').addEventListener('click', async () => {
  if (!ui.run) return;
  const r = await board.stop(ui.run.runId);
  if (!ui.run) return;
  clearInterval(ui.run.timer);
  if (r === 'interrupt') setStatus('停止しています…（もう一度押すと強制終了）', 'running');
  else if (r === 'force') setStatus('強制終了しています…', 'ng');
});
$('#clear').addEventListener('click', () => term.clear());
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
        refit();
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
  refit();
  $('#search').focus();
});
