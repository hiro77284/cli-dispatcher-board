'use strict';
// Windows のコマンドライン引用処理。
// - quoteArg: CreateProcess / MSVCRT の規則で 1 つの引数を引用する（必要なときだけ "" で囲む）
// - escapeForCmd: cmd.exe /d /s /c "..." に渡すための引用（cross-spawn と同じ方式）
// - quoteForPowerShell: PowerShell の単一引用符リテラル

function quoteArg(arg) {
  const s = String(arg);
  if (s.length > 0 && !/[\s"]/.test(s)) return s;
  let out = '"';
  let backslashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      out += '\\'.repeat(backslashes) + ch;
      backslashes = 0;
    }
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(cmd) {
  return String(cmd).replace(CMD_META, '^$1');
}

// cmd.exe 経由で渡す引数。doubleEscape は npm の .cmd シム（node_modules\.bin\*.cmd）向け。
function escapeCmdArg(arg, doubleEscape = false) {
  let s = String(arg);
  s = s.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  s = s.replace(/(?=(\\+?)?)\1$/, '$1$1');
  s = `"${s}"`;
  s = s.replace(CMD_META, '^$1');
  if (doubleEscape) s = s.replace(CMD_META, '^$1');
  return s;
}

// shell: cmd 用。人が cmd に打ち込むのと同じ形にする（"/b" のように引用すると
// 組み込みコマンドがスイッチと解釈しないため、引用は必要なときだけ）。
function quoteForCmdLine(arg) {
  const s = String(arg);
  if (s.includes('"')) return escapeCmdArg(s);
  const q = quoteArg(s);
  if (q.startsWith('"')) return q; // 引用符の中では & | < > は文字として扱われる
  return q.replace(/([&|<>^()])/g, '^$1');
}

function quoteForPowerShell(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9_\-./\\:=,+@]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

module.exports = { quoteArg, escapeCmdCommand, escapeCmdArg, quoteForCmdLine, quoteForPowerShell };
