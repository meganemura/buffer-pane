# buffer-pane

[![test](https://github.com/meganemura/buffer-pane/actions/workflows/test.yml/badge.svg)](https://github.com/meganemura/buffer-pane/actions/workflows/test.yml)

A Claude Code plugin (a Claude Mod) that opens a pane beside the transcript
where you write the next things to tell the agent.

An idea for the next request frequently comes while the agent runs a long
turn. Text in the prompt box is one Enter away from the agent: Enter
interrupts the turn or puts the text in the queue. The pane is a place to
collect that text until you are ready.

- Write blocks of text in the pane while a turn runs.
- Press `[+]` beside a block to put that block into the prompt box, read it,
  then press Enter yourself.
- Press `[>]` to send the block as a prompt in one press.
- The buffer survives sessions. Each working directory has its own buffer.

## Requirements

- Claude Code 2.1.273 or later with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`
- A terminal session. Print mode (`-p`) has no pane.

## Install

```sh
claude plugin marketplace add meganemura/buffer-pane
claude plugin install buffer-pane@buffer-pane
```

To develop against a checkout, run the plugin from its working tree:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir /path/to/buffer-pane/plugin
```

To set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` for each session, add it to the
`env` of `settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

## Use

Type `/buffer-pane` to show the pane. Type it again to hide the pane.

```
[+] [>] [x]   rename the flag to --dry-run
[+] [>] [x] ✓ add a test for the empty list
              and one for a list of one
              the next thing to tell the agent

[+] replaces the prompt box with the block. [>] sends the block as a prompt. [x] deletes the block. Enter adds a line; Enter on an empty line ends the block.
```

- **Write a block.** Type in the last field. Press Enter to add a line to
  the block; the focus moves to the new line. Press Enter on the empty last
  line to end the block. A new empty field appears below for the next block.
- **Edit a block.** Move the focus to a line of the block and type. The pane
  saves each change. Enter on an empty line in the middle of a block removes
  that line.
- **Put a block into the prompt box.** Press `[+]`. The block goes into the
  prompt box and stays in the pane with a `✓`. You can send the block again.
  An edit to the block removes the `✓`.
- **Send a block as a prompt.** Press `[>]`. The block goes to the agent as
  your next prompt and leaves the pane. During a turn, it waits in the queue
  until the turn ends.
- **Delete a block.** Press `[x]`.

To press a control, click it, or move the focus to it with the arrow keys and
press Enter.

### `[+]` replaces the prompt box

`[+]` replaces all the text in the prompt box with the block. The
function-hooks API can only replace the box, and it cannot read the box, so
the plugin cannot warn you about text that is already there. Send a block
when the prompt box is empty.

When a dialog is open, the prompt box cannot take the text. The status line
then shows a message, and the block gets no `✓`.

### Blocks

The buffer is one text, and blank lines split it into blocks. A block has one
or more lines, and each line is one field. A line wider than the field is cut
with `…` on screen; the text is kept in full. Break long text into lines with
Enter.

### Where the buffer lives

The plugin store of Claude Code holds the buffer under the key
`buffer:<working directory>`. A session in another directory shows another
buffer.

## Development

Run `/plugin-types` one time in a new checkout. It writes the type
declarations to `.claude/types/`, which git ignores.

Run the three quality gates before a commit:

```sh
claude plugin validate plugin
npx -p typescript tsc -p plugin/hooks
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin
```

`docs/decisions/` holds the design decisions. `AGENTS.md` holds the rules for
changes to this repository.

## Status

Early access. The function-hooks API can change between Claude Code releases
without notice.
