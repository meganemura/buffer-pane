# 0009. The pane draws on Claude Code Desktop

- Status: accepted
- Date: 2026-10-15

## Context

Since Claude Code 2.1.287, mods load by default, and the Code tab of Claude Code Desktop draws
a mod's `Pane` on the `desktop` surface. The render hook drew only when `e.surface` was
`terminal` and passed every other surface to `next(e)`. On the desktop, `/buffer-pane` opened
a pane with no buffer in it.

The desktop's element table has `Box`, `Button`, `Input` and `Text` with the same props as the
terminal's. The mobile app's table has no `Input`.

A session whose surface draws its own prompt box can refuse `$.prompt.fill` with the cause
`no_composer`. The desktop draws its own prompt box, so `[+]` can fail there on every press.

## Decision

- The render hook draws the same tree on `terminal` and `desktop`. `Ui` is typed with
  `Elements['terminal' | 'desktop']`. Other surfaces still go to `next(e)`.
- When the engine refuses a fill with `no_composer`, the status line tells the person to press
  `[>]`, which sends the block as a prompt. Other refusals keep the old text. No block gets the
  sent mark.
- CI moves from Claude Code 2.1.273 to 2.1.280. The test kit of 2.1.273 presses a Button only
  on the terminal drawing; the kit of 2.1.280 presses one on the desktop drawing too. 2.1.280
  is the version grilling-pane pins, and it is 23 days old today. The `ui.open` stub of the
  tests answers `{ isPlaced: true }`, as the 2.1.280 declarations require.

## Consequences

- Tests render the pane on both surfaces and compare the trees, and press `[>]` on the desktop.
- The kit strips a `refusal` that a test hook answers, so the `no_composer` text is tested as
  the plain function `fillRefusedTextOf`.
- The pane does not copy a block to the clipboard as a fallback. `$.ui.copy` is not in 2.1.280.
- A check in the real desktop app is still to do: whether the desktop takes a fill, and how it
  paints the gutter.
