'use strict';
// commands フォルダの YAML を読み込み、コマンド定義を検査・正規化する。

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { placeholders } = require('./build');

const PARAM_TYPES = ['text', 'number', 'select', 'flag', 'file', 'folder'];
const SHELLS = ['none', 'cmd', 'powershell'];
const NAME_RE = /^[A-Za-z0-9_-]+$/;

function listYamlFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listYamlFiles(full));
    else if (/\.ya?ml$/i.test(ent.name)) out.push(full);
  }
  return out.sort();
}

function normalizeOptions(options) {
  return (options || []).map((o) =>
    o !== null && typeof o === 'object'
      ? { value: String(o.value), label: String(o.label ?? o.value) }
      : { value: String(o), label: String(o) }
  );
}

function normalizeParam(p, i, errors) {
  if (!p || typeof p !== 'object') {
    errors.push(`params の ${i + 1} 番目が正しくありません`);
    return null;
  }
  const name = String(p.name ?? '');
  if (!NAME_RE.test(name)) {
    errors.push(`params の ${i + 1} 番目: name は半角英数字・_・- で書いてください（"${name}"）`);
    return null;
  }
  const type = p.type ?? 'text';
  if (!PARAM_TYPES.includes(type)) {
    errors.push(`パラメータ "${name}": type は ${PARAM_TYPES.join(' / ')} のいずれかです（"${type}"）`);
    return null;
  }
  const param = {
    name,
    label: String(p.label ?? name),
    type,
    description: p.description ? String(p.description) : '',
    required: !!p.required,
    default: p.default,
    placeholder: p.placeholder ? String(p.placeholder) : '',
  };
  if (type === 'select') {
    param.options = normalizeOptions(p.options);
    param.allowCustom = !!p.allowCustom;
    if (param.options.length === 0) errors.push(`パラメータ "${name}": select には options が必要です`);
  }
  if (type === 'number') {
    if (p.min !== undefined) param.min = Number(p.min);
    if (p.max !== undefined) param.max = Number(p.max);
  }
  if (type === 'file') {
    param.save = !!p.save;
    param.filters = Array.isArray(p.filters) ? p.filters : [];
  }
  if (type === 'text') param.split = !!p.split;
  if (p.pattern) param.pattern = String(p.pattern);
  return param;
}

// 引数テンプレートの中の参照先を検査する
function checkArgs(items, names, shell, where, errors) {
  if (items === undefined) return;
  if (!Array.isArray(items)) {
    errors.push(`${where} は配列で書いてください`);
    return;
  }
  for (const item of items) {
    if (typeof item === 'string' || typeof item === 'number') {
      for (const n of placeholders(item)) {
        if (!names.has(n)) errors.push(`${where}: 未定義のパラメータ {{${n}}} を参照しています`);
      }
    } else if (item && typeof item === 'object' && 'raw' in item) {
      if (shell === 'none') errors.push(`${where}: raw は shell: cmd か powershell のときだけ使えます`);
      for (const n of placeholders(item.raw)) {
        if (!names.has(n)) errors.push(`${where}: 未定義のパラメータ {{${n}}} を参照しています`);
      }
    } else if (item && typeof item === 'object' && 'if' in item) {
      if (!names.has(String(item.if))) errors.push(`${where}: if が未定義のパラメータ "${item.if}" を参照しています`);
      checkArgs(item.args, names, shell, where, errors);
    } else {
      errors.push(`${where}: 解釈できない要素があります（${JSON.stringify(item)}）`);
    }
  }
}

function normalizeCommand(raw, fallbackId, file) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { errors: ['コマンド定義がオブジェクトではありません'] };
  const id = String(raw.id ?? fallbackId);
  const shell = raw.shell ?? 'none';
  if (!SHELLS.includes(shell)) errors.push(`shell は ${SHELLS.join(' / ')} のいずれかです（"${shell}"）`);
  if (!raw.program) errors.push('program（実行するプログラム）がありません');
  const params = [];
  (Array.isArray(raw.params) ? raw.params : []).forEach((p, i) => {
    const np = normalizeParam(p, i, errors);
    if (np) {
      if (params.some((q) => q.name === np.name)) errors.push(`パラメータ "${np.name}" が重複しています`);
      params.push(np);
    }
  });
  const names = new Set(params.map((p) => p.name));
  checkArgs(raw.args, names, shell, 'args', errors);
  for (const n of placeholders(raw.program ?? '')) if (!names.has(n)) errors.push(`program: 未定義のパラメータ {{${n}}}`);
  for (const n of placeholders(raw.cwd ?? '')) if (!names.has(n)) errors.push(`cwd: 未定義のパラメータ {{${n}}}`);
  const cmd = {
    id,
    name: String(raw.name ?? id),
    category: String(raw.category ?? 'その他'),
    description: raw.description ? String(raw.description) : '',
    program: String(raw.program ?? ''),
    shell,
    args: Array.isArray(raw.args) ? raw.args : [],
    params,
    cwd: raw.cwd ? String(raw.cwd) : null,
    env: raw.env && typeof raw.env === 'object' ? raw.env : {},
    confirm: raw.confirm ? String(raw.confirm) : null,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    file,
  };
  return { cmd, errors };
}

function loadCommands(dirs) {
  const commands = [];
  const errors = [];
  const seen = new Map();
  for (const dir of dirs) {
    for (const file of listYamlFiles(dir)) {
      let doc;
      try {
        doc = YAML.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        errors.push({ file, message: `YAML の書式エラー: ${e.message}` });
        continue;
      }
      if (doc === null || doc === undefined) continue;
      const base = path.basename(file).replace(/\.ya?ml$/i, '');
      const list = Array.isArray(doc.commands) ? doc.commands : [doc];
      list.forEach((raw, i) => {
        const { cmd, errors: errs } = normalizeCommand(raw, list.length > 1 ? `${base}-${i + 1}` : base, file);
        if (errs.length) {
          errors.push({ file, message: `${cmd ? `「${cmd.name}」: ` : ''}${errs.join(' / ')}` });
          return;
        }
        if (seen.has(cmd.id)) {
          errors.push({ file, message: `id "${cmd.id}" が ${seen.get(cmd.id)} と重複しています` });
          return;
        }
        seen.set(cmd.id, file);
        commands.push(cmd);
      });
    }
  }
  return { commands, errors };
}

module.exports = { loadCommands, normalizeCommand };
