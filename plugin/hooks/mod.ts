// The plugin's one function-hooks module (the validator admits one per plugin). `/buffer-pane`
// opens a pane beside the transcript that holds text the person writes for later: the next
// things to tell the agent. The buffer is one text. Blank lines split it into blocks, and a
// block has one or more lines. Each block has a `[+]` that writes the block into the prompt
// box, a `[>]` that submits the block as a prompt and deletes it, and a `[x]` that deletes it.
// The buffer lives in the plugin store, one key for each working directory, so it survives
// sessions and hot reloads.
//
// Each line is one `Input`. Enter in a line adds a line below it and moves the focus there;
// Enter in an empty last line closes the block. A `Client` editor was the plan for this, but
// keys reached a `Client` in one real-terminal run and in no run after it (docs/decisions/0009),
// while `Input`, `Button`, `Box` and `Text` worked in every run.
//
// Must NOT know about: what the person does with the prompt box after a fill; what the prompt
// box holds (the API cannot read it, and `prompt.fill` always replaces it); any other
// repository's buffer (one key, the current working directory's).
//
// It loads only where Claude Code has function hooks enabled. The engine's validator reads
// this file statically, so every call on `$` is spelled `$.noun.event(...)` and `$` is handed
// only to the function declarations at the top of the file; the rest of the module holds a
// `Host`, a bundle of closures built once at `session.start`.

import type { Elements, On, RenderElement } from 'claude-code'

const PANE_ID = 'buffer-pane'
const PANE_TITLE = 'buffer-pane'
const COMMAND = 'buffer-pane'

const STORE_KEY_PREFIX = 'buffer:'

const PANE_PADDING_RIGHT = 1

// `✓` is a long-established narrow symbol: it draws in one cell. A symbol that a font draws
// two cells wide would push the text field out of line with the rows that have no mark.
const SENT_MARK = '✓'
const NOT_SENT_MARK = ' '

// The width of the gutter in cells: three 3-cell buttons, the mark, and the gaps between them
// and before the field. The lines after the first, and the last empty block, are indented by
// this so every field starts in the same column.
const GUTTER_COLUMNS = 14

const FILL_REFUSED_TEXT = 'buffer-pane: the prompt box did not take the block (a dialog is open, or there is no prompt box)'
const SUBMIT_REFUSED_TEXT = 'buffer-pane: the prompt was refused: '
const NOTE = '[+] replaces the prompt box with the block. [>] sends the block as a prompt. [x] deletes the block. Enter adds a line; Enter on an empty line ends the block.'

// A new line's field is drawn on the redraw after `commit`, and `$.ui.focus` refuses a key
// that is not drawn yet. The move is retried for a few frames.
const FOCUS_RETRY_MS = 30
const FOCUS_RETRIES = 6

type Host = {
  cwd: () => Promise<string>
  status: (text: string | undefined) => void
  open: () => Promise<void>
  close: () => Promise<void>
  invalidate: () => void
  log: (text: string) => void
  register: () => Promise<unknown>
  fill: (text: string) => Promise<{ isFilled: boolean }>
  submit: (text: string) => Promise<{ drop?: string | undefined }>
  focus: (key: string) => Promise<{ deny?: string | undefined }>
  sleep: (ms: number) => Promise<void>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
}

// A line and a block each hold an id because their positions change when something above
// them is deleted. The id is the element key, so a field keeps its identity and its typed text.
export type Line = { id: number; text: string }
export type Block = { id: number; lines: Line[] }

// What the pane edits. `sent` holds the text of each block that a `[+]` wrote into the prompt
// box. A block shows the mark only while its text is in `sent`, so an edit removes the mark
// with no separate bookkeeping. The last block is the place to write the next thing: it is
// always there, and it is stored only once it has text.
export type Buffer = { blocks: Block[]; sent: string[]; nextId: number }

// What the store holds. The buffer is one text with blank lines between blocks, not a list:
// a person can read the stored value, and another editor can edit the same text. `draft` was
// the half-typed last line of an earlier version; it is read once and folded into the text.
export type Stored = { text: string; sent: string[] }

type State = {
  host: Host | null
  isOpen: boolean
  storeKey: string | null
  buffer: Buffer
}

// The host is a bundle of closures over `$`, built once at `session.start`, so the rest of
// this file never holds `$` itself. That is the validator's rule and also the seam a test
// fakes: every world a test builds stubs these same calls with `on(...)`.
function hostOf($: any): Host {
  return {
    cwd: () => $.session.cwd(),
    status: (text) => $.ui.status(text),
    open: () => $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true }),
    close: () => $.ui.close({ id: PANE_ID }),
    invalidate: () => $.ui.invalidate('ui.render'),
    log: (text) => $.ui.log(text),
    register: () => $.command.register({ name: COMMAND, description: 'Show or hide the buffer-pane' }),
    fill: (text) => $.prompt.fill({ text }),
    submit: (text) => $.prompt.submit({ text }),
    focus: (key) => $.ui.focus({ requestId: PANE_ID, key }),
    sleep: (ms) => $.clock.sleep(ms),
    storeGet: (key) => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function storeKeyOf(cwd: string): string {
  return `${STORE_KEY_PREFIX}${cwd}`
}

export function textOfBlock(block: Block): string {
  return block.lines.map((line) => line.text.trimEnd()).join('\n').trim()
}

function isEmptyBlock(block: Block): boolean {
  return textOfBlock(block) === ''
}

// A line that holds only spaces also separates blocks: a person cannot see the difference
// between that line and an empty line.
export function blockTextsOf(text: string): string[] {
  return text
    .split(/\n[ \t]*(?:\n[ \t]*)+/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
}

export function textOfBlocks(blocks: readonly Block[]): string {
  return blocks.map(textOfBlock).filter((text) => text !== '').join('\n\n')
}

// The buffer ends with an empty line: the place where the next thing is written. When the
// last block ends with text (a load, a deleted block, a closed block), an empty block is added
// below it. Typing does not go through here, so a block being written gets no empty block
// under it until the person closes it with Enter on its empty last line.
function withTrailingBlock(buffer: Buffer): Buffer {
  const lastLine = buffer.blocks.at(-1)?.lines.at(-1)
  if (lastLine !== undefined && lastLine.text.trim() === '') return buffer
  return { ...buffer, blocks: [...buffer.blocks, { id: buffer.nextId, lines: [{ id: buffer.nextId + 1, text: '' }] }], nextId: buffer.nextId + 2 }
}

// A mark for a text that is no longer in the buffer is dropped. Without this, a block that
// the person edits and then edits back shows a mark for a fill of a different text.
function withSentPruned(buffer: Buffer): Buffer {
  const texts = new Set(buffer.blocks.map(textOfBlock))
  return { ...buffer, sent: buffer.sent.filter((text) => texts.has(text)) }
}

function settled(buffer: Buffer): Buffer {
  return withTrailingBlock(withSentPruned(buffer))
}

export function emptyBuffer(): Buffer {
  return settled({ blocks: [], sent: [], nextId: 1 })
}

export function afterEditOf(buffer: Buffer, lineId: number, value: string): Buffer {
  return withSentPruned({
    ...buffer,
    blocks: buffer.blocks.map((block) => ({ ...block, lines: block.lines.map((line) => (line.id === lineId ? { ...line, text: value } : line)) })),
  })
}

// What Enter in a line does, and which field takes the focus after it:
// - a line with text gets a new empty line below it (the focus goes there);
// - an empty line that is the block's last, in a block with other lines, closes the block
//   (the focus goes to the first line of the next block, which is created if this was the
//   last block);
// - an empty line in the middle of a block is removed (the focus goes to the line below);
// - an empty line that is a block's only line does nothing.
export function afterEnterOf(buffer: Buffer, lineId: number, value: string): { buffer: Buffer; focusLineId: number | null } {
  const edited = afterEditOf(buffer, lineId, value)
  const blockIndex = edited.blocks.findIndex((block) => block.lines.some((line) => line.id === lineId))
  const block = edited.blocks[blockIndex]
  if (block === undefined) return { buffer: edited, focusLineId: null }
  const lineIndex = block.lines.findIndex((line) => line.id === lineId)

  if (value.trim() !== '') {
    const newLine: Line = { id: edited.nextId, text: '' }
    const lines = [...block.lines.slice(0, lineIndex + 1), newLine, ...block.lines.slice(lineIndex + 1)]
    const blocks = edited.blocks.map((candidate, index) => (index === blockIndex ? { ...candidate, lines } : candidate))
    return { buffer: settled({ ...edited, blocks, nextId: edited.nextId + 1 }), focusLineId: newLine.id }
  }

  if (block.lines.length === 1) return { buffer: edited, focusLineId: null }

  const lines = block.lines.filter((line) => line.id !== lineId)
  const blocks = edited.blocks.map((candidate, index) => (index === blockIndex ? { ...candidate, lines } : candidate))
  const next = settled({ ...edited, blocks })
  const isLast = lineIndex === block.lines.length - 1
  const focusBlock = isLast ? next.blocks[blockIndex + 1] : next.blocks[blockIndex]
  const focusLine = isLast ? focusBlock?.lines[0] : focusBlock?.lines[lineIndex]
  return { buffer: next, focusLineId: focusLine?.id ?? null }
}

export function afterRemoveOf(buffer: Buffer, blockId: number): Buffer {
  return settled({ ...buffer, blocks: buffer.blocks.filter((block) => block.id !== blockId) })
}

export function afterSentOf(buffer: Buffer, text: string): Buffer {
  return buffer.sent.includes(text) ? buffer : { ...buffer, sent: [...buffer.sent, text] }
}

export function isSentOf(buffer: Buffer, block: Block): boolean {
  return buffer.sent.includes(textOfBlock(block))
}

export function storedOf(buffer: Buffer): Stored {
  return { text: textOfBlocks(buffer.blocks), sent: withSentPruned(buffer).sent }
}

// What comes out of the store is this file's own past write, not the engine's word. A
// version with a different shape could have written it, so each field is checked. A value
// that does not fit reads as an empty buffer, never as an error: the pane must still open.
export function bufferFromStore(value: unknown): Buffer {
  if (typeof value !== 'object' || value === null) return emptyBuffer()
  const text = Reflect.get(value, 'text')
  const sent = Reflect.get(value, 'sent')
  const draft = Reflect.get(value, 'draft')
  if (typeof text !== 'string') return emptyBuffer()
  const texts = blockTextsOf(typeof draft === 'string' && draft.trim() !== '' ? `${text}\n\n${draft}` : text)
  let nextId = 1
  const blocks: Block[] = texts.map((blockText) => {
    const id = nextId
    nextId += 1
    const lines = blockText.split('\n').map((lineText) => {
      const line = { id: nextId, text: lineText }
      nextId += 1
      return line
    })
    return { id, lines }
  })
  return settled({
    blocks,
    sent: Array.isArray(sent) ? sent.filter((item): item is string => typeof item === 'string') : [],
    nextId,
  })
}

// Reads the buffer of the current working directory. It runs at `session.start` and again
// each time the pane opens, because the working directory can change during a session.
// It does not read again for a key that is already loaded: the state is newer than the store
// while a write is in flight.
async function load(state: State, host: Host): Promise<void> {
  const key = storeKeyOf(await host.cwd())
  if (key === state.storeKey) return
  state.buffer = bufferFromStore(await host.storeGet(key).catch(() => undefined))
  state.storeKey = key
}

// Every change goes through here: state first, then the store, then a redraw. The render
// hook never writes the store. It fires many times a second.
function commit(state: State, host: Host, buffer: Buffer): void {
  state.buffer = buffer
  if (state.storeKey !== null) {
    void host.storeSet(state.storeKey, storedOf(buffer)).catch((error: unknown) => {
      host.log(`buffer-pane: the buffer was not saved: ${messageOf(error)}`)
    })
  }
  host.invalidate()
}

function lineKeyOf(lineId: number): string {
  return `line:${lineId}`
}

// Moves the keyboard to a line's field. The field appears on the next redraw, so a refusal
// for a key that is not drawn is retried; any other refusal (the pane does not hold the
// keyboard) is final, and the ring stays where the person left it.
async function focusLine(host: Host, lineId: number): Promise<void> {
  const key = lineKeyOf(lineId)
  for (let attempt = 0; attempt < FOCUS_RETRIES; attempt += 1) {
    const { deny } = await host.focus(key)
    if (deny === undefined || !/drawn/i.test(deny)) return
    await host.sleep(FOCUS_RETRY_MS)
  }
}

function blockOf(state: State, blockId: number): Block | undefined {
  return state.buffer.blocks.find((candidate) => candidate.id === blockId)
}

// `[+]`: the block goes into the prompt box, and the person presses Enter.
async function fill(state: State, host: Host, blockId: number): Promise<void> {
  const block = blockOf(state, blockId)
  if (block === undefined || isEmptyBlock(block)) return
  const text = textOfBlock(block)
  const { isFilled } = await host.fill(text)
  if (!isFilled) {
    host.status(FILL_REFUSED_TEXT)
    return
  }
  host.status(undefined)
  // The block stays in the buffer. The pane is the source of truth: the person can lose the
  // text in the prompt box with one key, and then sends the same block again.
  commit(state, host, afterSentOf(state.buffer, text))
}

// `[>]`: the block goes to the model as a prompt (asked for, beside `[+]`: a block that needs no
// second look is sent in one press). `$.prompt.submit` runs the prompt when the session is idle,
// so a press during a turn queues it. The block is deleted once the prompt entered (asked for:
// a sent request is done, and a block that stays reads as one still to send). A refused prompt
// leaves the block in place.
async function submit(state: State, host: Host, blockId: number): Promise<void> {
  const block = blockOf(state, blockId)
  if (block === undefined || isEmptyBlock(block)) return
  const result = await host.submit(textOfBlock(block))
  if (result.drop !== undefined) {
    host.status(`${SUBMIT_REFUSED_TEXT}${result.drop}`)
    return
  }
  host.status(undefined)
  commit(state, host, afterRemoveOf(state.buffer, blockId))
}

function onEnter(state: State, host: Host, lineId: number, value: string): void {
  const { buffer, focusLineId } = afterEnterOf(state.buffer, lineId, value)
  commit(state, host, buffer)
  if (focusLineId !== null) void focusLine(host, focusLineId).catch(() => undefined)
}

// The real element types, so the typecheck refuses a prop the engine would refuse. One
// unknown prop drops the whole tree with no message. `Text` takes no `key`.
type Ui = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text' | 'Input'>

// A field on its own draws as wide as its text (real-terminal feedback). `InputProps` has no
// width, so the Box around it takes the rest of the row and the field fills the Box.
function fieldOf(ui: Ui, state: State, host: Host, line: Line, isFirstOfBuffer: boolean): RenderElement {
  const { Box, Input } = ui
  return Box({
    key: `${lineKeyOf(line.id)}:box`,
    flexGrow: 1,
    width: '100%',
    children: [
      Input({
        key: lineKeyOf(line.id),
        value: line.text,
        submitLabel: 'new line',
        ...(isFirstOfBuffer ? { autoFocus: true as const, placeholder: 'the next thing to tell the agent' } : {}),
        onInput: (value) => commit(state, host, afterEditOf(state.buffer, line.id, value)),
        onSubmit: (value) => onEnter(state, host, line.id, value),
      }),
    ],
  })
}

// No `hotkey` on a Button: a hotkey does not fire in a pane (measured in pull-request-pane,
// two terminal setups). The arrow keys with Enter, or a click, press a Button. `plain` draws
// the label alone, and the focus and the pointer still invert it, so the brackets of `[+]` are
// the only chrome and the gutter keeps a fixed width.
function gutterOf(ui: Ui, state: State, host: Host, block: Block): RenderElement[] {
  const { Button, Text } = ui
  const key = `block:${block.id}`
  return [
    Button({ key: `${key}:fill`, label: '[+]', plain: true, onPress: () => void fill(state, host, block.id).catch(() => undefined) }),
    Button({ key: `${key}:submit`, label: '[>]', plain: true, onPress: () => void submit(state, host, block.id).catch(() => undefined) }),
    Button({ key: `${key}:remove`, label: '[x]', plain: true, onPress: () => commit(state, host, afterRemoveOf(state.buffer, block.id)) }),
    Text({ color: 'green', children: isSentOf(state.buffer, block) ? SENT_MARK : NOT_SENT_MARK }),
  ]
}

// One row for each line. The first row of a block with text carries the gutter; every other
// row is indented by the gutter's width. The empty last block has no gutter: it has nothing
// to send or delete, and the field is where the next thing is written.
function blockRowsOf(ui: Ui, state: State, host: Host, block: Block, isFirstOfBuffer: boolean): RenderElement[] {
  const { Box } = ui
  const hasGutter = !isEmptyBlock(block)
  return block.lines.map((line, index) => {
    const isFirst = index === 0
    return Box({
      key: `${lineKeyOf(line.id)}:row`,
      flexDirection: 'row',
      width: '100%',
      columnGap: 1,
      ...(isFirst && hasGutter ? {} : { paddingLeft: GUTTER_COLUMNS }),
      children: [...(isFirst && hasGutter ? gutterOf(ui, state, host, block) : []), fieldOf(ui, state, host, line, isFirstOfBuffer && isFirst)],
    })
  })
}

function paneOf(ui: Ui, state: State, host: Host): RenderElement {
  const { Box, Text } = ui
  const rows: RenderElement[] = []
  state.buffer.blocks.forEach((block, index) => {
    rows.push(Box({ key: `block:${block.id}`, flexDirection: 'column', children: blockRowsOf(ui, state, host, block, index === 0) }))
  })
  return Box({
    key: 'buffer-pane',
    flexDirection: 'column',
    paddingTop: 1,
    paddingRight: PANE_PADDING_RIGHT,
    children: [
      // A blank row between blocks, as the stored text has one.
      Box({ flexDirection: 'column', rowGap: 1, children: rows }),
      Box({ flexDirection: 'column', marginTop: 1, children: [Text({ dimColor: true, children: NOTE })] }),
    ],
  })
}

export function register(on: On) {
  const state: State = { host: null, isOpen: false, storeKey: null, buffer: emptyBuffer() }

  on('session.start', async ($, e, next) => {
    state.host = hostOf($)
    await state.host.register().catch((error: unknown) => {
      state.host?.log(`buffer-pane: /${COMMAND} is not available: ${messageOf(error)}`)
    })
    // A hot reload of this module starts a new session under an open pane. The buffer is
    // read here so the first redraw after the reload shows it.
    await load(state, state.host).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const host = state.host
    if (host === null) return next(e)

    if (state.isOpen) {
      await host.close()
      state.isOpen = false
      return { text: 'buffer-pane hidden' }
    }

    await load(state, host)
    await host.open()
    state.isOpen = true
    return { text: 'buffer-pane shown' }
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || state.host === null) return next(e)
    if (e.surface !== 'terminal') return next(e)
    const { Box, Button, Text, Input } = await $.ui.resolve(e)
    return paneOf({ Box, Button, Text, Input }, state, state.host)
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) state.isOpen = false
    return result
  })
}
