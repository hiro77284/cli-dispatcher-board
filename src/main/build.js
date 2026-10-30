'use strict';
// コマンド定義と入力値から、実行する引数列と表示用のコマンドラインを組み立てる。
// Electron に依存しない純粋な処理（test/ から直接テストする）。

const { quoteArg, quoteForPowerShell } = require('./winquote');

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

function isEmpty(v) {
  return v === undefined || v === null || v === false || String(v).trim() === '';
}

// 文字列中のプレースホルダー名を列挙する
function placeholders(template) {
  const names = [];
  for (const m of String(template).matchAll(PLACEHOLDER)) names.push(m[1]);
  return names;
}

// 参照しているパラメータのどれかが空なら null（＝その引数は省く）
function substitute(template, values) {
  const names = placeholders(template);
  if (names.some((n) => isEmpty(values[n]))) return null;
  return String(template).replace(PLACEHOLDER, (_, n) => String(values[n] === true ? 'true' : values[n]));
}

// シェル風の単語分割（"..." と '...' の引用に対応）
function shellSplit(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(text)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

function conditionHolds(item, values) {
  const v = values[item.if];
  let ok;
  if (item.equals !== undefined) ok = !isEmpty(v) && String(v) === String(item.equals);
  else ok = !isEmpty(v);
  return item.not ? !ok : ok;
}

// 引数テンプレートを展開して { value, raw } の列にする
function expandArgs(items, values, paramsByName, out) {
  for (const item of items || []) {
    if (typeof item === 'string' || typeof item === 'number') {
      const tpl = String(item);
      const exact = tpl.match(/^\{\{\s*([A-Za-z0-9_-]+)\s*\}\}$/);
      const p = exact && paramsByName[exact[1]];
      if (p && p.split) {
        const v = values[p.name];
        if (!isEmpty(v)) for (const t of shellSplit(v)) out.push({ value: t, raw: false });
        continue;
      }
      const s = substitute(tpl, values);
      if (s !== null) out.push({ value: s, raw: false });
    } else if (item && typeof item === 'object') {
      if ('raw' in item) {
        const s = substitute(item.raw, values);
        if (s !== null) out.push({ value: s, raw: true });
      } else if ('if' in item) {
        if (conditionHolds(item, values)) expandArgs(item.args, values, paramsByName, out);
      }
    }
  }
  return out;
}

// 入力値の型をそろえ、既定値を補う
function normalizeValues(def, input) {
  const values = {};
  for (const p of def.params || []) {
    let v = input && Object.prototype.hasOwnProperty.call(input, p.name) ? input[p.name] : p.default;
    if (p.type === 'flag') v = v === true || v === 'true' || v === 1;
    else if (v === undefined || v === null) v = '';
    else v = String(v);
    values[p.name] = v;
  }
  return values;
}

function validateValues(def, values) {
  const errors = [];
  for (const p of def.params || []) {
    const v = values[p.name];
    const label = p.label || p.name;
    if (p.type === 'flag') continue;
    if (p.required && isEmpty(v)) {
      errors.push(`「${label}」を入力してください`);
      continue;
    }
    if (isEmpty(v)) continue;
    if (p.type === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(String(v).trim())) errors.push(`「${label}」は数値で入力してください`);
      else {
        const n = Number(v);
        if (p.min !== undefined && n < p.min) errors.push(`「${label}」は ${p.min} 以上にしてください`);
        if (p.max !== undefined && n > p.max) errors.push(`「${label}」は ${p.max} 以下にしてください`);
      }
    }
    if (p.type === 'select' && !p.allowCustom) {
      const ok = (p.options || []).some((o) => String(o.value) === String(v));
      if (!ok) errors.push(`「${label}」は一覧から選んでください`);
    }
    if (p.pattern && !new RegExp(p.pattern).test(String(v))) {
      errors.push(`「${label}」の形式が正しくありません`);
    }
  }
  return errors;
}

function displayLine(shell, program, tokens) {
  if (shell === 'powershell') {
    const head = /^[A-Za-z0-9_\-.]+$/.test(program) ? program : `& ${quoteForPowerShell(program)}`;
    return [head, ...tokens.map((t) => (t.raw ? t.value : quoteForPowerShell(t.value)))].join(' ');
  }
  return [quoteArg(program), ...tokens.map((t) => (t.raw ? t.value : quoteArg(t.value)))].join(' ');
}

// def: 正規化済みのコマンド定義、input: 画面の入力値
function buildCommand(def, input) {
  const values = normalizeValues(def, input);
  const errors = validateValues(def, values);
  const paramsByName = Object.fromEntries((def.params || []).map((p) => [p.name, p]));
  const program = substitute(def.program, values);
  if (program === null) errors.push('実行するプログラムが空になりました');
  const tokens = expandArgs(def.args, values, paramsByName, []);
  const cwd = def.cwd ? substitute(def.cwd, values) : null;
  const env = {};
  for (const [k, tpl] of Object.entries(def.env || {})) {
    const s = substitute(tpl, values);
    if (s !== null) env[k] = s;
  }
  const shell = def.shell || 'none';
  return {
    ok: errors.length === 0,
    errors,
    values,
    shell,
    program: program || '',
    tokens,
    cwd: cwd || null,
    env,
    display: program ? displayLine(shell, program, tokens) : '',
  };
}

module.exports = { buildCommand, shellSplit, substitute, placeholders, isEmpty, normalizeValues };
