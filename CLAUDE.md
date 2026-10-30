# CLI ディスパッチャーボード: 作業の決まりごと

CLI コマンドの起動パターンを YAML で登録し、GUI でパラメータを入れて実行・結果表示する Windows 11 向けアプリ。手順は `README.md`、定義ファイルの仕様は `docs/command-format.md`。

## 構成

- Electron + node-pty（ConPTY）+ xterm.js。ビルド工程なしの素の JavaScript（main は CommonJS、renderer は `<script>` 読み込み）。
- コマンドの組み立て（`build.js`）・定義の検査（`commands.js`）・起動方法の決定（`runner.js` の `planSpawn`）は Electron に依存しない純粋な処理にしておき、`npm test`（node:test）でテストする。
- renderer は `contextIsolation: true` / `sandbox: true`。Node の機能は `preload.js` の `window.board` 経由でだけ使う。

## 決まりごと

- 画面の文言・コメント・ドキュメントは日本語。
- 引数は文字列連結ではなく配列で組み立て、引用は `winquote.js` に集約する。Windows では node-pty に引数を 1 本のコマンドライン文字列で渡す（node-pty 自身の引用処理は使わない）。
- 定義ファイルの仕様を変えたら `docs/command-format.md` とサンプル（`commands/`）も合わせて直し、`npm test` の「同梱のサンプル定義がすべて読み込める」を通す。
- 実行の挙動（引用・cmd.exe 経由の判断など）を変えたら、テストを足してから直す。
- 同時実行：main は `runs`（runId → プロセス）で、renderer は出力タブ（1 実行 = 1 タブ = 1 xterm、`byRun` で runId から引く）で管理する。入力・リサイズ・停止はすべて runId 単位。
- 実行中のプロセスを止めるのに node-pty の `kill()` を最初に使わない。Windows（ConPTY）では補助プロセスが「AttachConsole failed」で落ちる。停止は Ctrl+C（`\x03` を書き込む）→ 2 秒後に `taskkill /T /F` の順で行い、`kill()` は最後の手段にする（`main.js` の `run:stop`）。

## バージョンとリリース

- セマンティック バージョニング。1.0.0 までは、互換性のない変更（定義ファイルの書き方が変わるなど）でマイナー、機能追加もマイナー、不具合の修正はパッチを上げる。
- バージョンの原本は `package.json` の `version`（画面とウィンドウのタイトルはここから表示する）。
- 変更をコミットするたびに、`CHANGELOG.md` の先頭の「未リリース」に追加・変更・修正を書いておく（無ければ `## [Unreleased]` を作る）。
- リリースするときは、`npm version <patch|minor> --no-git-tag-version` で `package.json` と `package-lock.json` を上げ、`CHANGELOG.md` の「未リリース」をそのバージョンと日付に書き換えて末尾にリンクを足し、コミットしてから `git tag vX.Y.Z` → `git push --follow-tags` → `gh release create vX.Y.Z --notes-file <その版の変更点>` の順で行う。

