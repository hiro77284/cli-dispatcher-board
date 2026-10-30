'use strict';
// 組み立てたコマンドを、どのプログラムにどんな引数で渡すかを決める（planSpawn）。
// 実際の起動は main.js が node-pty で行う。planSpawn は副作用がなくテストできる。

const fs = require('fs');
const path = require('path');
const { quoteArg, escapeCmdCommand, escapeCmdArg, quoteForCmdLine, quoteForPowerShell } = require('./winquote');

function getEnvVar(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// PATH（Windows では PATHEXT も）からプログラムの実体を探す
function resolveProgram(program, { env, platform, cwd, exists = isFile }) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const exts = win
    ? ['', ...(getEnvVar(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  const tryWithExts = (base) => {
    // Windows では拡張子なしのファイルは実行できないので、拡張子付きを優先する
    const hasExt = win && /\.[A-Za-z0-9]+$/.test(base);
    const order = win && !hasExt ? exts.slice(1) : exts;
    for (const e of order) if (exists(base + e)) return base + e;
    return null;
  };
  const hasDir = win ? /[\\/]/.test(program) : program.includes('/');
  if (hasDir) {
    const abs = p.isAbsolute(program) ? program : p.resolve(cwd || process.cwd(), program);
    return tryWithExts(abs);
  }
  const dirs = (getEnvVar(env, 'PATH') || '').split(win ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    const found = tryWithExts(p.join(d.replace(/^"|"$/g, ''), program));
    if (found) return found;
  }
  return null;
}

function posixQuote(s) {
  return /^[A-Za-z0-9_\-./=:,+@%]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function findPowerShell(env, platform) {
  for (const name of ['pwsh', ...(platform === 'win32' ? ['powershell'] : [])]) {
    const r = resolveProgram(name, { env, platform });
    if (r) return r;
  }
  return null;
}

// built: buildCommand の結果。戻り値 { file, args（Windows では 1 本のコマンドライン文字列）, cwd, env } か { error }
function planSpawn(built, { platform = process.platform, baseEnv = process.env, defaultCwd } = {}) {
  const win = platform === 'win32';
  const env = { ...baseEnv, PYTHONUNBUFFERED: '1', ...built.env };
  const cwd = built.cwd || defaultCwd || process.cwd();
  const { program, tokens, shell } = built;

  if (shell === 'cmd') {
    if (win) {
      const line = [quoteForCmdLine(program), ...tokens.map((t) => (t.raw ? t.value : quoteForCmdLine(t.value)))].join(' ');
      const comspec = getEnvVar(env, 'ComSpec') || 'cmd.exe';
      return { file: comspec, args: `/d /s /c "${line}"`, cwd, env };
    }
    // 開発用（Windows 以外）：sh で代用する
    const line = [program, ...tokens.map((t) => (t.raw ? t.value : posixQuote(t.value)))].join(' ');
    return { file: '/bin/sh', args: ['-c', line], cwd, env };
  }

  if (shell === 'powershell') {
    const ps = findPowerShell(env, platform);
    if (!ps) return { error: 'PowerShell（pwsh / powershell）が見つかりません' };
    const head = /^[A-Za-z0-9_\-.]+$/.test(program) ? program : `& ${quoteForPowerShell(program)}`;
    const script = [head, ...tokens.map((t) => (t.raw ? t.value : quoteForPowerShell(t.value)))].join(' ');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const psArgs = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
    return { file: ps, args: win ? psArgs.join(' ') : psArgs, cwd, env };
  }

  const resolved = resolveProgram(program, { env, platform, cwd });
  if (!resolved) return { error: `プログラム "${program}" が見つかりません（PATH を確認してください）` };

  if (win) {
    if (/\.(cmd|bat)$/i.test(resolved)) {
      // .cmd / .bat は cmd.exe 経由でしか起動できない。npm のシムは二重エスケープが必要
      const shim = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(resolved);
      const line = [escapeCmdCommand(resolved), ...tokens.map((t) => escapeCmdArg(t.value, shim))].join(' ');
      const comspec = getEnvVar(env, 'ComSpec') || 'cmd.exe';
      return { file: comspec, args: `/d /s /c "${line}"`, cwd, env };
    }
    return { file: resolved, args: tokens.map((t) => quoteArg(t.value)).join(' '), cwd, env };
  }
  return { file: resolved, args: tokens.map((t) => t.value), cwd, env };
}

module.exports = { planSpawn, resolveProgram };
