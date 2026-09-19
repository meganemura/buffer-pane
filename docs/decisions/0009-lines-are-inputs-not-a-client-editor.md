# 0009. Lines are Inputs, not a Client editor

- Status: accepted. Supersedes the Milestone 2 plan in 0003.
- Date: 2026-09-19

## Context

0003 planned a `Client` editor for multi-line blocks, and 0008 measured how keys reach a
`Client`. In the run of 0008, keys reached the `Client` after a click on it. In every run after
that, in the same terminal and with the same probe, the `Client` received no key and no
pointer event: the count stayed at 0, and each typed character went to the prompt box. This
held with `onKey` alone, with `onPointer` alone, and with both. The cause was not found: the
sessions wrote no debug log, and the `Client` API gives the module no way to ask for the
focus (`UiFocusArgs.key` names a `Button`, `Input` or `Select`).

`Input`, `Button`, `Box` and `Text` received input in every run. `$.ui.focus` can move the
keyboard to an `Input` by key, and `$.clock.sleep` lets the module wait for the redraw that
draws a new field.

## Decision

- A block is a list of lines, and each line is one `Input`. The gutter (`[+]`, `[>]`, `[x]`,
  the mark) sits on the first line of a block; the other lines are indented by its width.
- Enter in a line with text adds an empty line below it, and the module moves the focus there
  with `$.ui.focus`. The move is retried for a few frames, because the field is drawn on the
  redraw after the store write.
- Enter in the empty last line of a block closes the block: the line is removed, and the focus
  goes to the first line of the next block. When the closed block was the last one, an empty
  block appears below it. Enter in an empty middle line removes that line.
- The buffer always ends with an empty line, the place to write the next thing. A block being
  written gets no empty block under it until it is closed.
- The store shape is `{ text, sent }`. The `draft` of the earlier shape is read once and
  folded in as a last block.

## Consequences

- A line wider than the field is cut with `…` by `Input`; that is the field's own drawing.
  A person breaks long text into lines with Enter.
- The plugin has no `Client` and no surface module. Drag to reorder blocks, and drag text into
  the prompt box, need pointer events, which only a `Client` receives; both wait until keys
  and pointer events reach a `Client` in a repeatable way.
- The test kit cannot type into an `Input` (0006), so Enter's effect is tested as
  `afterEnterOf`, and the focus move is tested as a stub of `ui.focus`.
