'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildCommand, shellSplit } = require('../src/main/build');
const { normalizeCommand, loadCommands } = require('../src/main/commands');
const { quoteArg, escapeCmdArg, quoteForCmdLine } = require('../src/main/winquote');
const { planSpawn, resolveProgram } = require('../src/main/runner');

function def(raw) {
  const { cmd, errors } = normalizeCommand(raw, 'x', 'x.yaml');
  assert.deepEqual(errors, []);
  return cmd;
}

const ffmpeg = def({
  name: 'ffmpeg 変換',
  program: 'ffmpeg',
  params: [
    { name: 'input', type: 'file', required: true },
    { name: 'crf', type: 'number', default: 23, min: 0, max: 51 },
    { name: 'overwrite', type: 'flag' },
    { name: 'preset', type: 'select', options: ['fast', 'slow'], default: 'fast' },
    { name: 'extra', type: 'text', split: true },
    { name: 'output', type: 'file', required: true },
  ],
  args: [
    { if: 'overwrite', args: ['-y'] },
    '-i',
    '{{input}}',
    { if: 'crf', args: ['-crf', '{{crf}}'] },
    { if: 'preset', equals: 'slow', args: ['-preset', 'slow'] },
    '{{extra}}',
    '{{output}}',
  ],
});

test('引数の組み立て（条件・既定値・分割）', () => {
  const b = buildCommand(ffmpeg, { input: 'C:\\動画\\in file.mp4', output: 'out.mp4', overwrite: true, extra: '-vf "scale=1280:-1"' });
  assert.equal(b.ok, true);
  assert.deepEqual(b.tokens.map((t) => t.value), ['-y', '-i', 'C:\\動画\\in file.mp4', '-crf', '23', '-vf', 'scale=1280:-1', 'out.mp4']);
  assert.equal(b.display, 'ffmpeg -y -i "C:\\動画\\in file.mp4" -crf 23 -vf scale=1280:-1 out.mp4');
});

test('空のパラメータを参照する引数は省かれる / equals 条件', () => {
  const b = buildCommand(ffmpeg, { input: 'a', output: 'b', crf: '', preset: 'slow' });
  assert.deepEqual(b.tokens.map((t) => t.value), ['-i', 'a', '-preset', 'slow', 'b']);
});

test('入力チェック', () => {
  const b = buildCommand(ffmpeg, { input: '', output: 'b', crf: '99', preset: 'medium' });
  assert.equal(b.ok, false);
  assert.ok(b.errors.some((e) => e.includes('「input」を入力')));
  assert.ok(b.errors.some((e) => e.includes('51 以下')));
  assert.ok(b.errors.some((e) => e.includes('一覧から選んで')));
});

test('定義の誤りを検出する', () => {
  const { errors } = normalizeCommand({ program: 'x', args: ['{{nope}}', { raw: '| sort' }], params: [{ name: 'a b' }] }, 'x', 'f');
  assert.ok(errors.some((e) => e.includes('{{nope}}')));
  assert.ok(errors.some((e) => e.includes('raw は')));
  assert.ok(errors.some((e) => e.includes('name は半角')));
});

test('shellSplit', () => {
  assert.deepEqual(shellSplit(`a "b c" 'd "e"' ""`), ['a', 'b c', 'd "e"', '']);
});

test('Windows の引用', () => {
  assert.equal(quoteArg('abc'), 'abc');
  assert.equal(quoteArg(''), '""');
  assert.equal(quoteArg('a b'), '"a b"');
  assert.equal(quoteArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
  assert.equal(quoteArg('say "hi"'), '"say \\"hi\\""');
  assert.equal(escapeCmdArg('a&b'), '^"a^&b^"');
  assert.equal(quoteForCmdLine('a&b'), 'a^&b');
  assert.equal(quoteForCmdLine('a & b'), '"a & b"');
});

test('Windows での起動計画（.exe 直接 / .cmd は cmd.exe 経由 / PATH 不在）', () => {
  const files = new Set(['c:\\tools\\ffmpeg.exe', 'c:\\node\\npm.cmd']);
  const env = { Path: 'C:\\Tools;C:\\node', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
  const exists = (p) => files.has(p.toLowerCase()); // Windows のファイル名は大文字小文字を区別しない
  assert.equal(resolveProgram('ffmpeg', { env, platform: 'win32', exists }), 'C:\\Tools\\ffmpeg.EXE');
  assert.equal(resolveProgram('npm', { env, platform: 'win32', exists }), 'C:\\node\\npm.CMD');
  assert.equal(resolveProgram('nothing', { env, platform: 'win32', exists }), null);

  // planSpawn は実ファイルを見るので、ここでは cmd シェルの組み立てだけ確かめる
  const dir = def({ program: 'dir', shell: 'cmd', params: [{ name: 'p' }], args: ['/b', '{{p}}', { raw: '| sort' }] });
  const plan = planSpawn(buildCommand(dir, { p: 'C:\\a b' }), { platform: 'win32', baseEnv: env });
  assert.equal(plan.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(plan.args, '/d /s /c "dir /b "C:\\a b" | sort"');
});

test('PowerShell は EncodedCommand で渡す', () => {
  const ps = def({ program: 'Get-ChildItem', shell: 'powershell', params: [{ name: 'p' }], args: ['-Path', '{{p}}'] });
  const b = buildCommand(ps, { p: "it's here" });
  assert.equal(b.display, "Get-ChildItem -Path 'it''s here'");
});

test('同梱のサンプル定義がすべて読み込める', () => {
  const { commands, errors } = loadCommands([path.join(__dirname, '..', 'commands')]);
  assert.deepEqual(errors, []);
  assert.ok(commands.length >= 5);
});
