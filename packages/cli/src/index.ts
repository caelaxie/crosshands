import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { ComputerOperationName } from '@crosshands/contract'

import { dispatchPublicOperation } from './intent/dispatch.js'

export type CliBrokerClient = {
  request(operation: ComputerOperationName, input: unknown): Promise<unknown>
  close(): Promise<void>
}

export type CliIo = {
  stdin(): Promise<string>
  stdout(value: string): void
  stderr(value: string): void
}

type Flags = Map<string, string | true>

const BOOLEAN_FLAGS = new Set([
  'json',
  'no-screenshot',
  'restore-window',
  'text-stdin',
  'value-stdin'
])

const COMMANDS: Record<string, ComputerOperationName | 'doctor'> = {
  capabilities: 'capabilities',
  permissions: 'permissions',
  'list-apps': 'listApps',
  'list-windows': 'listWindows',
  'get-app-state': 'getAppState',
  click: 'click',
  'perform-secondary-action': 'performSecondaryAction',
  scroll: 'scroll',
  drag: 'drag',
  'type-text': 'typeText',
  'press-key': 'pressKey',
  hotkey: 'hotkey',
  'paste-text': 'pasteText',
  'set-value': 'setValue',
  doctor: 'doctor'
}

const ALLOWED: Record<string, readonly string[]> = {
  capabilities: ['json'],
  permissions: ['json', 'id'],
  'list-apps': ['json'],
  'list-windows': ['json', 'app'],
  'get-app-state': [
    'json',
    'app',
    'context',
    'window-id',
    'window-index',
    'goal',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  click: [
    'json',
    'app',
    'context',
    'element-index',
    'x',
    'y',
    'click-count',
    'mouse-button',
    'modifiers',
    'goal',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  'perform-secondary-action': [
    'json',
    'app',
    'context',
    'element-index',
    'action',
    'goal',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  scroll: [
    'json',
    'app',
    'context',
    'element-index',
    'x',
    'y',
    'direction',
    'pages',
    'goal',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  drag: [
    'json',
    'app',
    'context',
    'from-element-index',
    'to-element-index',
    'from-x',
    'from-y',
    'to-x',
    'to-y',
    'duration-ms',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  'type-text': [
    'json',
    'app',
    'context',
    'text',
    'text-stdin',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  'press-key': [
    'json',
    'app',
    'context',
    'key',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  hotkey: ['json', 'app', 'context', 'key', 'no-screenshot', 'restore-window', 'screenshot-output'],
  'paste-text': [
    'json',
    'app',
    'context',
    'text',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  'set-value': [
    'json',
    'app',
    'context',
    'element-index',
    'value',
    'value-stdin',
    'goal',
    'no-screenshot',
    'restore-window',
    'screenshot-output'
  ],
  doctor: ['json']
}

const EXIT_CODES: Record<string, number> = {
  invalid_argument: 2,
  provider_unavailable: 3,
  permission_denied: 4,
  stale_target: 5,
  interaction_context_invalid: 5,
  interaction_context_expired: 5,
  app_blocked: 6,
  unsupported_capability: 7,
  action_not_supported: 7,
  timeout: 8,
  version_incompatible: 9,
  session_unavailable: 10,
  goal_mismatch: 5,
  policy_unavailable: 5,
  intent_unavailable: 2
}

class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation = 'correct_request'
  ) {
    super(message)
  }
}

function parseFlags(args: string[], command: string): Flags {
  const flags: Flags = new Map()
  const allowed = new Set(ALLOWED[command] ?? [])
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index]
    if (raw === undefined || !raw.startsWith('--'))
      throw new CliError('invalid_argument', `Unexpected argument: ${raw ?? ''}`)
    const name = raw.slice(2)
    if (name === 'worktree' || name === 'session') {
      throw new CliError(
        'invalid_argument',
        `--${name} was an Orca routing flag and is not used by standalone CrossHands; use --context from get-app-state instead`,
        'remove_orca_routing_flag'
      )
    }
    if (!allowed.has(name)) throw new CliError('invalid_argument', `Unknown flag --${name}`)
    if (flags.has(name)) throw new CliError('invalid_argument', `Duplicate flag --${name}`)
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true)
      continue
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--'))
      throw new CliError('invalid_argument', `Missing value for --${name}`)
    flags.set(name, value)
    index += 1
  }
  return flags
}

function stringFlag(flags: Flags, name: string, required = false): string | undefined {
  const value = flags.get(name)
  if (typeof value === 'string') return value
  if (required) throw new CliError('invalid_argument', `Missing required --${name}`)
  return undefined
}

function numberFlag(
  flags: Flags,
  name: string,
  options: { integer?: boolean; min?: number } = {}
): number | undefined {
  const raw = stringFlag(flags, name)
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isInteger(value)) ||
    (options.min !== undefined && value < options.min)
  ) {
    throw new CliError('invalid_argument', `Invalid --${name}`)
  }
  return value
}

function observationFlags(flags: Flags): Record<string, unknown> {
  return {
    ...(flags.has('no-screenshot') ? { captureScreenshot: false } : {}),
    ...(flags.has('restore-window') ? { restoreWindow: true } : {})
  }
}

function windowSelector(flags: Flags): unknown {
  const id = stringFlag(flags, 'window-id')
  const index = numberFlag(flags, 'window-index', { integer: true, min: 0 })
  if (id !== undefined && index !== undefined)
    throw new CliError('invalid_argument', 'Choose either --window-id or --window-index')
  return id === undefined ? (index === undefined ? undefined : { index }) : { id }
}

function contextToken(flags: Flags): string {
  return stringFlag(flags, 'context', true)!
}

function elementTarget(flags: Flags, name = 'element-index'): unknown {
  const index = numberFlag(flags, name, { integer: true, min: 0 })
  if (index === undefined) throw new CliError('invalid_argument', `Missing required --${name}`)
  return { kind: 'element', elementIndex: index }
}

function chordTokens(raw: string): string[] {
  return raw.split('+')
}

function parseClickModifiers(flags: Flags): string[] | undefined {
  const raw = stringFlag(flags, 'modifiers')
  if (raw === undefined) return undefined
  const modifiers = chordTokens(raw).filter((token) => token.length > 0)
  if (modifiers.length === 0 || modifiers.length > 4)
    throw new CliError('invalid_argument', 'Invalid --modifiers')
  return modifiers
}

function optionalGoal(flags: Flags): { goal?: string } {
  const goal = stringFlag(flags, 'goal')
  return goal === undefined ? {} : { goal }
}

function pointOrElement(flags: Flags): unknown {
  const element = numberFlag(flags, 'element-index', { integer: true, min: 0 })
  const x = numberFlag(flags, 'x')
  const y = numberFlag(flags, 'y')
  const hasCoordinates = x !== undefined || y !== undefined
  if (element !== undefined && hasCoordinates)
    throw new CliError('invalid_argument', 'Choose an element index or coordinates, not both')
  if (element !== undefined) return { kind: 'element', elementIndex: element }
  if (hasCoordinates) {
    if (x === undefined || y === undefined)
      throw new CliError('invalid_argument', 'Coordinates require both --x and --y')
    return { kind: 'coordinate', x, y }
  }
  if (stringFlag(flags, 'goal') !== undefined) return { kind: 'intent' }
  throw new CliError('invalid_argument', 'Choose an element index, coordinates, or --goal')
}

async function protectedText(flags: Flags, name: 'text' | 'value', io: CliIo): Promise<string> {
  const literal = stringFlag(flags, name)
  const stdin = flags.has(`${name}-stdin`)
  if ((literal === undefined) === !stdin)
    throw new CliError('invalid_argument', `Choose exactly one of --${name} or --${name}-stdin`)
  return stdin ? await io.stdin() : literal!
}

async function operationInput(command: string, flags: Flags, io: CliIo): Promise<unknown> {
  const common = () => {
    const app = stringFlag(flags, 'app')
    return {
      contextToken: contextToken(flags),
      ...(app === undefined ? {} : { app }),
      ...observationFlags(flags)
    }
  }
  switch (command) {
    case 'capabilities':
    case 'list-apps':
      return {}
    case 'permissions': {
      const id = stringFlag(flags, 'id')
      if (id !== undefined && id !== 'accessibility' && id !== 'screenshots')
        throw new CliError('invalid_argument', '--id must be accessibility or screenshots')
      return id === undefined ? {} : { id }
    }
    case 'list-windows':
      return { app: stringFlag(flags, 'app', true) }
    case 'get-app-state': {
      const context = stringFlag(flags, 'context')
      const window = windowSelector(flags)
      if (context !== undefined) {
        return {
          contextToken: context,
          ...optionalGoal(flags),
          ...observationFlags(flags)
        }
      }
      return {
        app: stringFlag(flags, 'app', true),
        ...(window === undefined ? {} : { window }),
        ...optionalGoal(flags),
        ...observationFlags(flags)
      }
    }
    case 'click': {
      const clickCount = numberFlag(flags, 'click-count', { integer: true, min: 1 })
      const button = stringFlag(flags, 'mouse-button')
      if (button !== undefined && !['left', 'right', 'middle'].includes(button))
        throw new CliError('invalid_argument', 'Invalid --mouse-button')
      const modifiers = parseClickModifiers(flags)
      return {
        ...common(),
        target: pointOrElement(flags),
        ...optionalGoal(flags),
        ...(clickCount === undefined ? {} : { clickCount }),
        ...(button === undefined ? {} : { button }),
        ...(modifiers === undefined ? {} : { modifiers })
      }
    }
    case 'perform-secondary-action':
      return {
        ...common(),
        target:
          numberFlag(flags, 'element-index', { integer: true, min: 0 }) !== undefined ||
          stringFlag(flags, 'goal') === undefined
            ? elementTarget(flags)
            : { kind: 'intent' },
        action: stringFlag(flags, 'action', true),
        ...optionalGoal(flags)
      }
    case 'scroll': {
      const direction = stringFlag(flags, 'direction', true)!
      if (!['up', 'down', 'left', 'right'].includes(direction))
        throw new CliError('invalid_argument', 'Invalid --direction')
      const pages = numberFlag(flags, 'pages', { integer: true, min: 1 })
      return {
        ...common(),
        target: pointOrElement(flags),
        direction,
        ...optionalGoal(flags),
        ...(pages === undefined ? {} : { pages })
      }
    }
    case 'drag': {
      const fromElement = numberFlag(flags, 'from-element-index', { integer: true, min: 0 })
      const toElement = numberFlag(flags, 'to-element-index', { integer: true, min: 0 })
      const coordinates = ['from-x', 'from-y', 'to-x', 'to-y'].map((name) =>
        numberFlag(flags, name)
      )
      const endpoint = (
        label: string,
        element: number | undefined,
        x: number | undefined,
        y: number | undefined
      ): unknown => {
        if (element !== undefined && (x !== undefined || y !== undefined))
          throw new CliError('invalid_argument', `Choose one selector for drag ${label}`)
        if (element !== undefined) return { kind: 'element', elementIndex: element }
        if (x !== undefined && y !== undefined) return { kind: 'coordinate', x, y }
        throw new CliError('invalid_argument', `Drag ${label} requires an element or coordinates`)
      }
      const from = endpoint('start', fromElement, coordinates[0], coordinates[1])
      const to = endpoint('end', toElement, coordinates[2], coordinates[3])
      const durationMs = numberFlag(flags, 'duration-ms', { integer: true, min: 50 })
      return {
        ...common(),
        from,
        to,
        ...(durationMs === undefined ? {} : { durationMs })
      }
    }
    case 'type-text':
    case 'paste-text':
      return {
        ...common(),
        target: { kind: 'context-window' },
        text: await protectedText(flags, 'text', io)
      }
    case 'press-key':
      return {
        ...common(),
        target: { kind: 'context-window' },
        key: stringFlag(flags, 'key', true)
      }
    case 'hotkey': {
      const keys = chordTokens(stringFlag(flags, 'key', true)!)
      if (keys.length < 2 || keys.some((key) => key.length === 0))
        throw new CliError('invalid_argument', 'Hotkeys require a modifier and key')
      return { ...common(), target: { kind: 'context-window' }, keys }
    }
    case 'set-value':
      return {
        ...common(),
        target:
          numberFlag(flags, 'element-index', { integer: true, min: 0 }) !== undefined ||
          stringFlag(flags, 'goal') === undefined
            ? elementTarget(flags)
            : { kind: 'intent' },
        value: await protectedText(flags, 'value', io),
        ...optionalGoal(flags)
      }
    default:
      throw new CliError('invalid_argument', `Unknown computer command: ${command}`)
  }
}

function readiness(capabilities: unknown): string {
  if (capabilities === null || typeof capabilities !== 'object') return 'unavailable'
  const record = capabilities as Record<string, unknown>
  const permissions = record.permissions
  if (permissions !== null && typeof permissions === 'object') {
    const values = Object.values(permissions)
    if (values.includes('denied') || values.includes('unknown')) return 'operator_action_required'
  }
  const operations = record.operations
  if (operations !== null && typeof operations === 'object') {
    const values = Object.values(operations)
    if (values.includes(false)) return 'capability_reduced'
  }
  return 'ready'
}

async function runDoctor(client: CliBrokerClient): Promise<unknown> {
  const capabilities = await client.request('capabilities', {})
  const permissions = await client.request('permissions', {})
  const capabilityResult =
    capabilities !== null && typeof capabilities === 'object' && 'result' in capabilities
      ? (capabilities as Record<string, unknown>).result
      : capabilities
  return { readiness: readiness(capabilityResult), checks: { capabilities, permissions } }
}

function publicBrokerResult(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'requestId' in value && 'result' in value)
    return (value as Record<string, unknown>).result
  return value
}

function serializedError(cause: unknown): Record<string, unknown> {
  if (cause !== null && typeof cause === 'object') {
    const record = cause as Record<string, unknown>
    if (typeof record.toJSON === 'function')
      return (record.toJSON as () => Record<string, unknown>)()
    return {
      code: typeof record.code === 'string' ? record.code : 'provider_unavailable',
      message:
        cause instanceof Error
          ? cause.message
          : typeof record.message === 'string'
            ? record.message
            : 'Request failed',
      retry: typeof record.retry === 'boolean' ? record.retry : false,
      remediation: typeof record.remediation === 'string' ? record.remediation : 'run_doctor'
    }
  }
  return {
    code: 'provider_unavailable',
    message: 'Request failed',
    retry: false,
    remediation: 'run_doctor'
  }
}

function findScreenshot(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.screenshot !== null && typeof record.screenshot === 'object') {
    const screenshot = record.screenshot as Record<string, unknown>
    if (typeof screenshot.data === 'string') return screenshot
  }
  for (const nested of Object.values(record)) {
    const found = findScreenshot(nested)
    if (found !== undefined) return found
  }
  return undefined
}

async function exportScreenshot(value: unknown, destination: string): Promise<void> {
  const screenshot = findScreenshot(value)
  if (screenshot === undefined)
    throw new CliError('invalid_argument', 'Result has no screenshot data to export')
  const absolute = resolve(destination)
  const parent = dirname(absolute)
  const parentInfo = await lstat(parent).catch(() => undefined)
  if (parentInfo === undefined || !parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new CliError('invalid_argument', 'Screenshot output parent must be a real directory')
  const existing = await lstat(absolute).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return undefined
    throw cause
  })
  if (existing !== undefined)
    throw new CliError(
      'invalid_argument',
      'Screenshot output already exists; overwrite is forbidden'
    )
  const bytes = Buffer.from(screenshot.data as string, 'base64')
  const handle = await open(
    absolute,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(absolute, 0o600)
  delete screenshot.data
  Object.assign(screenshot, {
    path: absolute,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    dataOmitted: true
  })
}

export async function runCli(argv: string[], io: CliIo, client: CliBrokerClient): Promise<number> {
  let json = false
  try {
    if (argv[0] !== 'computer')
      throw new CliError('invalid_argument', 'Usage: crosshands computer <command> --json')
    const command = argv[1]
    if (command === undefined || COMMANDS[command] === undefined)
      throw new CliError('invalid_argument', `Unknown computer command: ${command ?? ''}`)
    const flags = parseFlags(argv.slice(2), command)
    json = flags.has('json')
    const operation = COMMANDS[command]!
    const brokerResult =
      operation === 'doctor'
        ? await runDoctor(client)
        : publicBrokerResult(
            await dispatchPublicOperation(
              client,
              operation,
              await operationInput(command, flags, io)
            )
          )
    const result = structuredClone(brokerResult)
    const screenshotOutput = stringFlag(flags, 'screenshot-output')
    if (screenshotOutput !== undefined) await exportScreenshot(result, screenshotOutput)
    io.stdout(`${JSON.stringify(result)}\n`)
    return 0
  } catch (cause) {
    const error = serializedError(cause)
    io.stdout(`${JSON.stringify({ error })}\n`)
    if (!json) io.stderr(`${String(error.message)}\n`)
    return EXIT_CODES[String(error.code)] ?? 1
  } finally {
    await client.close().catch(() => undefined)
  }
}

export { createProductionBrokerClient, localClientPaths } from './local-client.js'
export type { LocalClientPaths, ProductionClientOptions } from './local-client.js'
export { dispatchPublicOperation } from './intent/dispatch.js'
export { parseJevEnv, brokerSpawnEnv } from './intent/env.js'
