// Tests for the plugin's function-hooks module, run by `claude plugin test plugin` with
// `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The kit loads the module as the engine does and hands
// each test the engine's own `$`; the hooks a test registers with `on` sit beneath the module,
// where the prompt box, the store and the terminal would be. All buffer text here is invented.
//
// A known gap: the kit cannot type into an `Input`. Its `$.ui` has `render`, `scroll`, `focus`
// and `press`, and `press` reaches a `Button` only (measured: a press on an Input's key is
// refused with "no Button ... is drawn"). The drawn tree carries no `onInput` or `onSubmit`
// closure either; the engine keeps them under a numeric handle. So what Enter and typing do to
// the buffer is tested as the plain functions the closures call (`afterEnterOf`,
// `afterEditOf`, `storedOf`, `storeKeyOf`). The path from a change to `store.set` is tested
// end to end through the Buttons, which use the same `commit` the Input closures use.

import type { CommandRunInput, On, RenderInput } from 'claude-code'
import { describe, expect, test, tier } from 'claude-code/testing'

import {
  afterEditOf,
  afterEnterOf,
  afterRemoveOf,
  afterSentOf,
  blockTextsOf,
  bufferFromStore,
  emptyBuffer,
  isSentOf,
  storedOf,
  storeKeyOf,
  textOfBlock,
} from '../hooks/mod'
import type { Buffer } from '../hooks/mod'

tier('user')

const PLUGIN = 'buffer-pane'
const COMMAND = 'buffer-pane'

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: PLUGIN,
  viewport: { columns: 120, rows: 40 },
  props: { title: PLUGIN, isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
}

const RUN: CommandRunInput = { command: COMMAND, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

type WorldOptions = {
  cwd?: string
  // Seeds `$.store` before `session.start` runs, so a test can simulate a hot reload: the
  // module's own in-memory state is gone, but a real store's persistence is not.
  store?: Record<string, unknown>
  isFilled?: boolean
  drop?: string
}

// The world beneath the module: a working directory, a store, a prompt box that takes a fill
// (or refuses it), and a terminal that keeps what was opened, closed and told as a status line.
function world(on: On, options: WorldOptions = {}) {
  const cwd = options.cwd ?? '/work'
  const opened: string[] = []
  const closed: string[] = []
  const statuses: (string | undefined)[] = []
  const fills: string[] = []
  const submits: string[] = []
  const reads: string[] = []
  const focused: string[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.cwd', () => ({ value: cwd }))
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: undefined }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  // A chain event: it answers the result itself, not `{ value }`.
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: options.isFilled ?? true }
  })

  // A chain event: it answers the result itself, not `{ value }`.
  on('ui.focus', ($, e) => {
    focused.push(e.element ?? '')
    return {}
  })
  on('clock.sleep', () => ({ value: undefined }))
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return options.drop === undefined ? { text: e.text } : { drop: options.drop }
  })

  const store = new Map<string, unknown>(Object.entries(options.store ?? {}))
  on('store.get', ($, e) => {
    reads.push(e.key)
    return { value: store.get(e.key) }
  })
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })

  return { cwd, opened, closed, statuses, fills, submits, reads, focused, store, session: { surface: 'terminal', isInteractive: true, cwd } as const }
}

type Row = { key: string; mark: string; lines: string[] }

// Each block of a drawn tree: the keyed Box, the mark its gutter holds (empty for the last,
// empty block, which has no gutter), and the value of each line's Input.
function rowsOf(tree: unknown): Row[] {
  if (Array.isArray(tree)) return tree.flatMap(rowsOf)
  if (typeof tree !== 'object' || tree === null) return []
  const props: unknown = Reflect.get(tree, 'props')
  const children: unknown = Reflect.get(tree, 'children')
  const key = typeof props === 'object' && props ? Reflect.get(props, 'key') : undefined
  if (typeof key === 'string' && /^block:\d+$/.test(key)) {
    const mark = textsOf(children).find((text) => text === '✓' || text === ' ') ?? ''
    const lines = inputsOf(children).map((input) => String(input['value']))
    return [{ key, mark, lines }]
  }
  return rowsOf(children)
}

// The key of every Button in a tree, in document order.
function buttonKeysOf(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(buttonKeysOf)
  if (typeof tree !== 'object' || tree === null) return []
  if (Reflect.get(tree, 'type') === 'Button') return [String(Reflect.get(Reflect.get(tree, 'props') as object, 'key'))]
  return buttonKeysOf(Reflect.get(tree, 'children'))
}

// The text of every Text node in a tree.
function textsOf(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(textsOf)
  if (typeof tree !== 'object' || tree === null) return []
  if (Reflect.get(tree, 'type') === 'Text') return [(Reflect.get(tree, 'children') as unknown[]).join('')]
  return textsOf(Reflect.get(tree, 'children'))
}

// The `props` of every Input in a drawn tree.
function inputsOf(tree: unknown): Record<string, unknown>[] {
  if (Array.isArray(tree)) return tree.flatMap(inputsOf)
  if (typeof tree !== 'object' || tree === null) return []
  if (Reflect.get(tree, 'type') === 'Input') return [Reflect.get(tree, 'props') as Record<string, unknown>]
  return inputsOf(Reflect.get(tree, 'children'))
}

function textOf(tree: unknown): string {
  if (Array.isArray(tree)) return tree.map(textOf).join('\n')
  if (typeof tree !== 'object' || tree === null) return typeof tree === 'string' ? tree : ''
  return textOf(Reflect.get(tree, 'children'))
}

// A Button's `onPress` is not awaited by `$.ui.press`; it finishes after a few turns of the
// task queue. `setTimeout` is reached through the global object, as the module names no host
// globals of its own.
async function settle(): Promise<void> {
  const later = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => unknown }).setTimeout
  for (let i = 0; i < 8; i += 1) await new Promise<void>((resolve) => later(resolve, 0))
}

const SEED = { text: 'rename the flag to --dry-run\n\nadd a test for the empty list', sent: [] }

// Ids as bufferFromStore assigns them for SEED: block 1 (line 2), block 3 (line 4), then the
// empty last block 5 (line 6).
const EMPTY_LAST: Row = { key: 'block:5', mark: '', lines: [''] }

describe('the pane', () => {
  test('/buffer-pane opens the pane, and a second /buffer-pane closes it', async ($, on) => {
    const kept = world(on)
    await $.session.start(kept.session)

    const first = await $.command.run(RUN)
    expect(first.text).toBe('buffer-pane shown')
    expect(kept.opened).toEqual([PLUGIN])

    const second = await $.command.run(RUN)
    expect(second.text).toBe('buffer-pane hidden')
    expect(kept.closed).toEqual([PLUGIN])
  })

  test('a buffer in the store is drawn after session.start, with no command run first', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': SEED } })
    await $.session.start(kept.session)

    const tree = await $.ui.render(PANE)

    expect(rowsOf(tree)).toEqual([
      { key: 'block:1', mark: ' ', lines: ['rename the flag to --dry-run'] },
      { key: 'block:3', mark: ' ', lines: ['add a test for the empty list'] },
      EMPTY_LAST,
    ])
    expect(textOf(tree)).toContain('replaces the prompt box')
  })

  test('the first line takes the focus and shows the placeholder; every line is a field', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': SEED } })
    await $.session.start(kept.session)

    const inputs = inputsOf(await $.ui.render(PANE))

    expect(inputs[0]).toEqual({ key: 'line:2', value: 'rename the flag to --dry-run', submitLabel: 'new line', autoFocus: true, placeholder: 'the next thing to tell the agent' })
    expect(inputs.map((input) => input['key'])).toEqual(['line:2', 'line:4', 'line:6'])
  })

  test('a draft from the earlier store shape becomes the last block with text', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': { ...SEED, draft: 'half a thou' } } })
    await $.session.start(kept.session)

    expect(rowsOf(await $.ui.render(PANE)).map((row) => row.lines)).toEqual([['rename the flag to --dry-run'], ['add a test for the empty list'], ['half a thou'], ['']])
  })

  test('a block with two lines draws two fields under one gutter', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': { text: 'first line\nsecond line', sent: [] } } })
    await $.session.start(kept.session)

    const tree = await $.ui.render(PANE)

    expect(rowsOf(tree)).toEqual([{ key: 'block:1', mark: ' ', lines: ['first line', 'second line'] }, { key: 'block:4', mark: '', lines: [''] }])
    // One gutter: three buttons for the block, none for the second line or the empty block.
    expect(buttonKeysOf(tree)).toEqual(['block:1:fill', 'block:1:submit', 'block:1:remove'])
  })

  test('a press on [+] fills the prompt box with that block, and the block stays with a mark', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': SEED } })
    await $.session.start(kept.session)
    await $.ui.render(PANE)

    await $.ui.press({ plugin: PLUGIN, key: 'block:3:fill' })
    await settle()

    expect(kept.fills).toEqual(['add a test for the empty list'])
    expect(rowsOf(await $.ui.render(PANE)).map((row) => row.mark)).toEqual([' ', '✓', ''])
    expect(kept.store.get('buffer:/work')).toEqual({ ...SEED, sent: ['add a test for the empty list'] })
  })

  test('when the prompt box refuses the fill, a status line says so and no mark is drawn', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': SEED }, isFilled: false })
    await $.session.start(kept.session)
    await $.ui.render(PANE)

    await $.ui.press({ plugin: PLUGIN, key: 'block:1:fill' })
    await settle()

    expect(kept.statuses).toHaveLength(1)
    expect(kept.statuses[0]).toContain('did not take the block')
    expect(rowsOf(await $.ui.render(PANE)).map((row) => row.mark)).toEqual([' ', ' ', ''])
  })

  test('a press on [>] submits that block as a prompt and deletes it', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': SEED } })
    await $.session.start(kept.session)
    await $.ui.render(PANE)

    await $.ui.press({ plugin: PLUGIN, key: 'block:1:submit' })
    await settle()

    expect(kept.submits).toEqual(['rename the flag to --dry-run'])
    expect(kept.fills).toEqual([])
    expect(rowsOf(await $.ui.render(PANE))).toEqual([{ key: 'block:3', mark: ' ', lines: ['add a test for the empty list'] }, EMPTY_LAST])
    expect(kept.store.get('buffer:/work')).toEqual({ text: 'add a test for the empty list', sent: [] })
  })

  test('when a hook refuses the prompt, a status line says why and the block stays', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': SEED }, drop: 'not now' })
    await $.session.start(kept.session)
    await $.ui.render(PANE)

    await $.ui.press({ plugin: PLUGIN, key: 'block:1:submit' })
    await settle()

    expect(kept.statuses).toEqual(['buffer-pane: the prompt was refused: not now'])
    expect(rowsOf(await $.ui.render(PANE)).map((row) => row.key)).toEqual(['block:1', 'block:3', 'block:5'])
  })

  test('a press on [x] deletes that block and writes the store', async ($, on) => {
    const kept = world(on, { store: { 'buffer:/work': SEED } })
    await $.session.start(kept.session)
    await $.ui.render(PANE)

    await $.ui.press({ plugin: PLUGIN, key: 'block:1:remove' })
    await settle()

    // The block that remains keeps its key: the row of block 3 does not become block 1.
    expect(rowsOf(await $.ui.render(PANE))).toEqual([{ key: 'block:3', mark: ' ', lines: ['add a test for the empty list'] }, EMPTY_LAST])
    expect(kept.store.get('buffer:/work')).toEqual({ text: 'add a test for the empty list', sent: [] })
  })

  test('another working directory reads and writes another key', async ($, on) => {
    const kept = world(on, { cwd: '/elsewhere', store: { 'buffer:/work': SEED, 'buffer:/elsewhere': { text: 'bump the version', sent: [] } } })
    await $.session.start(kept.session)

    expect(rowsOf(await $.ui.render(PANE)).map((row) => row.lines)).toEqual([['bump the version'], ['']])
    expect(kept.reads).toEqual(['buffer:/elsewhere'])

    await $.ui.press({ plugin: PLUGIN, key: 'block:1:remove' })
    await settle()

    expect(kept.store.get('buffer:/elsewhere')).toEqual({ text: '', sent: [] })
    expect(kept.store.get('buffer:/work')).toEqual(SEED)
  })
})

// A buffer with one block of the given lines, then the empty last block.
function bufferOf(...lines: string[]): Buffer {
  return bufferFromStore({ text: lines.join('\n'), sent: [] })
}

function linesOf(buffer: Buffer): string[][] {
  return buffer.blocks.map((block) => block.lines.map((line) => line.text))
}

describe('the buffer', () => {
  test('the store key holds the working directory', () => {
    expect(storeKeyOf('/work')).toBe('buffer:/work')
  })

  test('an empty buffer has one empty block, and stores as empty text', () => {
    expect(linesOf(emptyBuffer())).toEqual([['']])
    expect(storedOf(emptyBuffer())).toEqual({ text: '', sent: [] })
  })

  test('Enter in a line with text adds an empty line below it and focuses it', () => {
    const one = bufferOf('first')
    const { buffer, focusLineId } = afterEnterOf(one, 2, 'first')

    expect(linesOf(buffer)).toEqual([['first', ''], ['']])
    expect(focusLineId).toBe(buffer.blocks[0]!.lines[1]!.id)
    expect(storedOf(buffer)).toEqual({ text: 'first', sent: [] })
  })

  test('typing into the empty last block opens it: no block appears below until Enter closes it', () => {
    const typed = afterEditOf(emptyBuffer(), 2, 'typed now')
    expect(linesOf(typed)).toEqual([['typed now']])

    const { buffer } = afterEnterOf(typed, 2, 'typed now')
    expect(linesOf(buffer)).toEqual([['typed now', '']])
    expect(storedOf(buffer).text).toBe('typed now')
  })

  test('Enter in the empty last line of a block closes it: the next block takes the focus', () => {
    const open = afterEnterOf(bufferOf('first'), 2, 'first').buffer
    const emptyLineId = open.blocks[0]!.lines[1]!.id

    const { buffer, focusLineId } = afterEnterOf(open, emptyLineId, '')

    expect(linesOf(buffer)).toEqual([['first'], ['']])
    expect(focusLineId).toBe(buffer.blocks[1]!.lines[0]!.id)
    expect(storedOf(buffer).text).toBe('first')
  })

  test('two blocks store with a blank line between them', () => {
    const open = afterEnterOf(bufferOf('first'), 2, 'first').buffer
    const closed = afterEnterOf(open, open.blocks[0]!.lines[1]!.id, '').buffer
    const nextLineId = closed.blocks[1]!.lines[0]!.id

    const { buffer } = afterEnterOf(closed, nextLineId, 'second')

    expect(storedOf(buffer).text).toBe('first\n\nsecond')
    expect(linesOf(buffer)).toEqual([['first'], ['second', '']])
  })

  test('Enter in an empty middle line removes it and focuses the line below', () => {
    const two = bufferOf('a', 'c')
    const three = afterEnterOf(two, two.blocks[0]!.lines[0]!.id, 'a').buffer
    expect(linesOf(three)).toEqual([['a', '', 'c'], ['']])
    const middleId = three.blocks[0]!.lines[1]!.id

    const { buffer, focusLineId } = afterEnterOf(three, middleId, '')

    expect(linesOf(buffer)).toEqual([['a', 'c'], ['']])
    expect(focusLineId).toBe(buffer.blocks[0]!.lines[1]!.id)
  })

  test('Enter in the only, empty line of a block does nothing', () => {
    const empty = emptyBuffer()
    const { buffer, focusLineId } = afterEnterOf(empty, 2, '')

    expect(buffer).toEqual(empty)
    expect(focusLineId).toBe(null)
  })

  test('a line that is emptied stays until Enter; a block of empty lines is not stored', () => {
    const edited = afterEditOf(bufferOf('first'), 2, '')

    expect(linesOf(edited)).toEqual([[''], ['']])
    expect(storedOf(edited).text).toBe('')
  })

  test('ids are not used again after a block is deleted', () => {
    const two = bufferOf('a')
    const withB = afterEnterOf(two, two.blocks[1]!.lines[0]!.id, 'b').buffer
    const again = afterRemoveOf(withB, withB.blocks[0]!.id)

    expect(again.blocks.map((block) => block.id)).toEqual(withB.blocks.slice(1).map((block) => block.id))
    expect(again.nextId).toBe(withB.nextId)
  })

  test('an edit removes the sent mark, and the mark does not come back with the old text', () => {
    const sent = afterSentOf(bufferOf('ship it'), 'ship it')
    expect(isSentOf(sent, sent.blocks[0]!)).toBe(true)

    const edited = afterEditOf(sent, 2, 'ship it now')
    expect(isSentOf(edited, edited.blocks[0]!)).toBe(false)

    const back = afterEditOf(edited, 2, 'ship it')
    expect(isSentOf(back, back.blocks[0]!)).toBe(false)
  })

  test('a space typed at the end of a sent line keeps the mark, also after a load', () => {
    const sent = afterSentOf(bufferOf('ship it'), 'ship it')
    const spaced = afterEditOf(sent, 2, 'ship it ')

    expect(isSentOf(spaced, spaced.blocks[0]!)).toBe(true)
    const loaded = bufferFromStore(storedOf(spaced))
    expect(isSentOf(loaded, loaded.blocks[0]!)).toBe(true)
  })

  test('the text of a two-line block is its lines joined with a newline', () => {
    expect(textOfBlock(bufferOf('one', 'two').blocks[0]!)).toBe('one\ntwo')
  })

  test('blank lines split the stored text into blocks; a block keeps its inner newline', () => {
    expect(blockTextsOf('one\nstill one\n\n\ntwo\n  \nthree\n')).toEqual(['one\nstill one', 'two', 'three'])
    expect(blockTextsOf('')).toEqual([])
  })

  test('wide characters pass through the store unchanged', () => {
    const buffer = afterSentOf(bufferOf('空のリストのテストを足す'), '空のリストのテストを足す')

    expect(bufferFromStore(storedOf(buffer))).toEqual(buffer)
  })

  test('a store value of another shape reads as an empty buffer', () => {
    expect(bufferFromStore(undefined)).toEqual(emptyBuffer())
    expect(bufferFromStore({ blocks: ['old shape'] })).toEqual(emptyBuffer())
    expect(linesOf(bufferFromStore({ text: 'kept', sent: 'not a list' }))).toEqual([['kept'], ['']])
  })
})
