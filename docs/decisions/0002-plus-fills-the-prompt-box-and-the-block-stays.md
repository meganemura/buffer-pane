# 0002. `[+]` fills the prompt box, and the block stays

- Status: accepted
- Date: 2026-09-17

## Context

`$.prompt.fill({ text })` replaces the content of the prompt box and puts the cursor at the
end. Replace is the one behavior that the type declarations give it, and they give a module
no call that reads the box. `prompt.fill` resolves
`{ isFilled: false }` when a dialog holds the keys or the session has no prompt box.

`ButtonProps.hover` takes style overrides only (`TextHoverProps`), so a Button cannot show a
sentence on hover.

## Decision

- `[+]` calls `prompt.fill` with the text of the block. The plugin never submits a prompt: the
  person reads the box and presses Enter.
- A dim line at the bottom of the pane says that `[+]` replaces the prompt box. The README says
  the same.
- When the fill is refused, the status line shows one sentence and the block gets no mark.
- The block stays in the buffer after a fill. The pane is the source of truth: the person can
  lose the text in the box with one key, and can then send the same block again. `[x]` is the
  one way to delete a block.
- A sent block shows `✓` in the gutter. `✓` draws one cell wide; a symbol that a font draws two
  cells wide would move the text field out of line.
- The store keeps the text of each sent block. A block shows `✓` while its text is in that
  list. Each change to the buffer drops the entries that match no block, so an edit removes the
  mark, and the mark stays away when the person types the old text again.

## Consequences

- Text that is already in the prompt box is lost on `[+]`. The plugin cannot warn about it,
  because it cannot read the box.
- Two blocks with the same text share one mark.
