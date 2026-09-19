// The plugin's one function-hooks module (the validator admits one per plugin). `/buffer-pane`
// opens a pane beside the transcript that holds text the person writes for later: the next
// things to tell the agent. The buffer is one text. Blank lines split it into blocks. Each
// block has a `[+]` that writes the block into the prompt box, a `[>]` that submits the block as
// a prompt and deletes it, and a `[x]` that deletes it. The
// buffer lives in the plugin store, one key for each working directory, so it survives sessions
// and hot reloads.
//
// Must NOT know about: what the person does with the prompt box after a fill; what the prompt box holds
// (the API cannot read it, and `prompt.fill` always replaces it); any other repository's
// buffer (one key, the current working directory's).
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

const FILL_REFUSED_TEXT = 'buffer-pane: the prompt box did not take the block (a dialog is open, or there is no prompt box)'
const SUBMIT_REFUSED_TEXT = 'buffer-pane: the prompt was refused: '
const REPLACE_NOTE = '[+] replaces the prompt box with the block. [>] sends the block as a prompt. [x] deletes the block.'

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
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
}

// A block holds an id because its position changes when `[x]` deletes a block above it. The
// id is the element key, so the text field of block 3 does not become the text field of
// block 2 under the person's cursor.
export type Block = { id: number; text: string }

// What the pane edits. `sent` holds the text of each block that a `[+]` wrote into the prompt
// box. A block shows the mark only while its text is in `sent`, so an edit removes the mark
// with no separate bookkeeping. `draft` is the text in the new-block field before Enter.
export type Buffer = { blocks: Block[]; sent: string[]; draft: string; nextId: number }

// What the store holds. The buffer is one text with blank lines between blocks, not a list:
// a later multi-line editor edits the same text, and a person can read the stored value.
export type Stored = { text: string; sent: string[]; draft: string }

type State = {
  host: Host | null
  isOpen: boolean
  storeKey: string | null
  buffer: Buffer
  // Counts Enter presses in the new-block field. The count is part of that field's key, so
  // each Enter draws a new element. The surface keeps the typed text of an element it has
  // seen before, and an empty `value` drawn again for the same key might not clear it.
  draftGeneration: number
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

export function emptyBuffer(): Buffer {
  return { blocks: [], sent: [], draft: '', nextId: 1 }
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
  return blocks
    .map((block) => block.text.trim())
    .filter((text) => text !== '')
    .join('\n\n')
}

// A mark for a text that is no longer in the buffer is dropped. Without this, a block that
// the person edits and then edits back shows a mark for a fill of a different text.
function withSentPruned(buffer: Buffer): Buffer {
  const texts = new Set(buffer.blocks.map((block) => block.text.trim()))
  return { ...buffer, sent: buffer.sent.filter((text) => texts.has(text)) }
}

export function afterSubmitOf(buffer: Buffer, value: string): Buffer {
  const text = value.trim()
  if (text === '') return { ...buffer, draft: '' }
  return { ...buffer, blocks: [...buffer.blocks, { id: buffer.nextId, text }], draft: '', nextId: buffer.nextId + 1 }
}

export function afterDraftOf(buffer: Buffer, value: string): Buffer {
  return { ...buffer, draft: value }
}

export function afterEditOf(buffer: Buffer, id: number, value: string): Buffer {
  return withSentPruned({ ...buffer, blocks: buffer.blocks.map((block) => (block.id === id ? { ...block, text: value } : block)) })
}

// Enter in the field of a block that the person emptied deletes the block. An empty block
// has nothing to send, and the stored text could not hold it.
export function afterEditSubmitOf(buffer: Buffer, id: number, value: string): Buffer {
  if (value.trim() === '') return afterRemoveOf(buffer, id)
  return afterEditOf(buffer, id, value.trim())
}

export function afterRemoveOf(buffer: Buffer, id: number): Buffer {
  return withSentPruned({ ...buffer, blocks: buffer.blocks.filter((block) => block.id !== id) })
}

// `sent` holds trimmed text, the form the store keeps (`textOfBlocks`). A field holds the text
// as typed, with a possible space at the end, so each comparison trims first. Without this, a
// block sent with a space at its end loses its mark on the next load.
export function afterSentOf(buffer: Buffer, text: string): Buffer {
  const sent = text.trim()
  return buffer.sent.includes(sent) ? buffer : { ...buffer, sent: [...buffer.sent, sent] }
}

export function isSentOf(buffer: Buffer, block: Block): boolean {
  return buffer.sent.includes(block.text.trim())
}

export function storedOf(buffer: Buffer): Stored {
  return { text: textOfBlocks(buffer.blocks), sent: withSentPruned(buffer).sent, draft: buffer.draft }
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
  const blocks = blockTextsOf(text).map((blockText, index) => ({ id: index + 1, text: blockText }))
  return withSentPruned({
    blocks,
    sent: Array.isArray(sent) ? sent.filter((item): item is string => typeof item === 'string') : [],
    draft: typeof draft === 'string' ? draft : '',
    nextId: blocks.length + 1,
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

function blockTextOf(state: State, id: number): string {
  const block = state.buffer.blocks.find((candidate) => candidate.id === id)
  return block?.text.trim() ?? ''
}

// `[+]`: the block goes into the prompt box, and the person presses Enter.
async function fill(state: State, host: Host, id: number): Promise<void> {
  const text = blockTextOf(state, id)
  if (text === '') return
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
async function submit(state: State, host: Host, id: number): Promise<void> {
  const text = blockTextOf(state, id)
  if (text === '') return
  const result = await host.submit(text)
  if (result.drop !== undefined) {
    host.status(`${SUBMIT_REFUSED_TEXT}${result.drop}`)
    return
  }
  host.status(undefined)
  commit(state, host, afterRemoveOf(state.buffer, id))
}

// The real element types, so the typecheck refuses a prop the engine would refuse. One
// unknown prop drops the whole tree with no message. `Text` takes no `key`.
type Ui = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text' | 'Input'>

// No `hotkey` on a Button: a hotkey does not fire in a pane (measured in pull-request-pane,
// two terminal setups). The arrow keys with Enter, or a click, press a Button. `plain` draws
// the label alone, and the focus and the pointer still invert it, so the brackets of `[+]` are
// the only chrome and the gutter keeps a fixed width.
function blockRowOf(ui: Ui, block: Block, state: State, host: Host): RenderElement {
  const { Box, Button, Text, Input } = ui
  const key = `block:${block.id}`
  return Box({
    key,
    flexDirection: 'row',
    width: '100%',
    columnGap: 1,
    children: [
      Button({ key: `${key}:fill`, label: '[+]', plain: true, onPress: () => void fill(state, host, block.id).catch(() => undefined) }),
      Button({ key: `${key}:submit`, label: '[>]', plain: true, onPress: () => void submit(state, host, block.id).catch(() => undefined) }),
      Button({ key: `${key}:remove`, label: '[x]', plain: true, onPress: () => commit(state, host, afterRemoveOf(state.buffer, block.id)) }),
      Text({ color: 'green', children: isSentOf(state.buffer, block) ? SENT_MARK : NOT_SENT_MARK }),
      fieldBoxOf(ui, `${key}:field`, Input({
        key: `${key}:text`,
        value: block.text,
        submitLabel: 'save',
        onInput: (value) => commit(state, host, afterEditOf(state.buffer, block.id, value)),
        onSubmit: (value) => commit(state, host, afterEditSubmitOf(state.buffer, block.id, value)),
      })),
    ],
  })
}

// A field on its own draws as wide as its text (real-terminal feedback: the new-block field was
// too narrow to write in). `InputProps` has no width, so the Box around it takes the rest of
// the row and the field fills the Box.
function fieldBoxOf(ui: Ui, key: string, field: RenderElement): RenderElement {
  return ui.Box({ key, flexGrow: 1, width: '100%', children: [field] })
}

function draftRowOf(ui: Ui, state: State, host: Host): RenderElement {
  const { Box, Input } = ui
  return Box({
    key: 'draft',
    flexDirection: 'row',
    width: '100%',
    // Lines the field up with the block fields: three 3-cell buttons, the mark, four gaps.
    paddingLeft: 14,
    children: [
      fieldBoxOf(ui, 'draft:field', Input({
        key: `draft:${state.draftGeneration}`,
        value: state.buffer.draft,
        placeholder: 'the next thing to tell the agent',
        submitLabel: 'add block',
        autoFocus: true,
        onInput: (value) => commit(state, host, afterDraftOf(state.buffer, value)),
        onSubmit: (value) => {
          state.draftGeneration += 1
          commit(state, host, afterSubmitOf(state.buffer, value))
        },
      })),
    ],
  })
}

function paneOf(ui: Ui, state: State, host: Host): RenderElement {
  const { Box, Text } = ui
  return Box({
    key: 'buffer-pane',
    flexDirection: 'column',
    paddingTop: 1,
    paddingRight: PANE_PADDING_RIGHT,
    children: [
      Box({ flexDirection: 'column', children: [...state.buffer.blocks.map((block) => blockRowOf(ui, block, state, host)), draftRowOf(ui, state, host)] }),
      Box({ flexDirection: 'column', marginTop: 1, children: [Text({ dimColor: true, children: REPLACE_NOTE })] }),
    ],
  })
}

export function register(on: On) {
  const state: State = { host: null, isOpen: false, storeKey: null, buffer: emptyBuffer(), draftGeneration: 0 }

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
