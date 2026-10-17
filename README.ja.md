# buffer-pane

[English](README.md)

[![test](https://github.com/meganemura/buffer-pane/actions/workflows/test.yml/badge.svg)](https://github.com/meganemura/buffer-pane/actions/workflows/test.yml)

buffer-pane は、transcript の横に pane を開き、次に agent に伝えることを書いておける Claude Code の plugin（mod）である。

agent が長いターンを実行している間に、次の依頼を思いつくことはよくある。
プロンプト欄の文字は、Enter 1 回で agent に届く。
Enter を押すとターンを中断するか、文字が順番待ちに入る。
pane は、準備ができるまでその文字をためておく場所である。

- ターンの実行中に、pane に文字の block を書く。
- block の横の `[+]` を押すと、その block がプロンプト欄に入る。内容を読んでから、自分で Enter を押す。
- `[>]` を押すと、1 回でその block をプロンプトとして送る。
- buffer はセッションをまたいで残る。作業ディレクトリごとに別の buffer を持つ。

## 必要なもの

- Claude Code 2.1.273 以降。Claude Code 2.1.287 以降は mod を標準で読み込む。それより古い版では `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` を設定する。
- terminal のセッション、または Claude Code Desktop の Code タブ。print mode（`-p`）には pane がない。

## インストール

```sh
claude plugin marketplace add meganemura/buffer-pane
claude plugin install buffer-pane@buffer-pane
```

checkout を使って開発するときは、作業ツリーから plugin を読み込む。

```sh
claude --plugin-dir /path/to/buffer-pane/plugin
```

### Claude Code Desktop

pane は Claude Code Desktop の Code タブにも描かれる。
上の command で user スコープにインストールした plugin は、Desktop でも読み込まれる。
Desktop では `/plugin` は動かない。
アプリからインストールするには、プロンプト欄の横の + を押し、Plugins、Add marketplace の順に進んで `meganemura/buffer-pane` を指定し、Add plugin を押す。

Desktop は `--plugin-dir` を受け取らない。
Desktop で checkout を使って開発するときは、`~/.claude/settings.json` の `env` に次を設定する。

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/buffer-pane/plugin",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

## 使い方

`/buffer-pane` で pane を表示する。
もう一度入力すると pane を隠す。

```
[+] [>] [x] [^] [v]   rename the flag to --dry-run
[+] [>] [x] [^] [v] ✓ add a test for the empty list
                      the next thing to tell the agent

[+] replaces the prompt box with the block. [>] sends the block as a prompt. [x] deletes the block. [^] [v] move the block.
```

- **block を追加する。** 最後の入力欄に入力して Enter を押す。block は入力欄の上に入り、入力欄は次の block のために空になる。
- **block を編集する。** その block の入力欄に focus を移して入力する。pane は変更のたびに保存する。
- **block をプロンプト欄に入れる。** `[+]` を押す。block はプロンプト欄に入り、`✓` が付いて pane にも残る。同じ block をもう一度送ることもできる。block を編集すると `✓` は消える。
- **block をプロンプトとして送る。** `[>]` を押す。block は次のプロンプトとして agent に届き、pane から消える。ターンの実行中は、ターンが終わるまで順番待ちに入る。
- **block を動かす。** `[^]` で 1 つ上へ、`[v]` で 1 つ下へ動かす。
- **block を消す。** `[x]` を押す。入力欄を空にして Enter を押しても消せる。

コントロールを押すには、クリックするか、矢印 key で focus を移して Enter を押す。

### `[+]` はプロンプト欄を置き換える

`[+]` は、プロンプト欄の文字をすべて block で置き換える。
function-hooks API はプロンプト欄を置き換えることしかできず、中身を読めない。
そのため plugin は、すでに入っている文字について警告できない。
block を送るのは、プロンプト欄が空のときにする。

ダイアログが開いている間は、プロンプト欄は文字を受け取れない。
そのときは status line にメッセージが出て、block に `✓` は付かない。

### block

buffer は 1 つのテキストであり、空行で block に分かれる。
この版では、1 つの block は 1 行である。
複数行の editor は次のマイルストーンである（[decision 0003](docs/decisions/0003-one-line-fields-first-then-a-multi-line-editor.md)）。

### buffer の保存場所

Claude Code の plugin store が、`buffer:<working directory>` という key で buffer を持つ。
別のディレクトリのセッションでは、別の buffer を表示する。

## 開発

新しい checkout では、`/plugin-types` を 1 回実行する。
型宣言を `.claude/types/` に書き出す。このディレクトリは git が無視する。

commit の前に、3 つのゲートを実行する。

```sh
claude plugin validate plugin
npx -p typescript tsc -p plugin/hooks
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin
```

`docs/decisions/` に設計の決定がある。
`AGENTS.md` に、このリポジトリを変更するときのルールがある。

## 状態

early access である。
function-hooks API は、Claude Code のリリースの間で予告なく変わることがある。
