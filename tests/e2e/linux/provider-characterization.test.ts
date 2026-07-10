import { readFile } from 'node:fs/promises'

import { describe, expect, test } from 'vitest'

describe('Linux provider source safety characterization', () => {
  test('keeps the native protocol on stdin/stdout and rejects operation files', async () => {
    const source = await readFile(
      new URL('../../../native/linux/runtime.py', import.meta.url),
      'utf8'
    )
    expect(source).toContain('for line in sys.stdin')
    expect(source).toContain('runtime accepts no operation-file arguments')
    expect(source).not.toContain('open(sys.argv[1]')
  })

  test('gates X11-only paths and preserves protected-field redaction', async () => {
    const source = await readFile(
      new URL('../../../native/linux/runtime.py', import.meta.url),
      'utf8'
    )
    expect(source).toContain('ensure_provider_available("syntheticPointer")')
    expect(source).toContain('ensure_provider_available("syntheticKeyboard")')
    expect(source).toContain('ensure_provider_available("hotkey")')
    expect(source).toContain('return "[redacted]"')
  })

  test('returns native screenshot failures and fresh post-action state', async () => {
    const [nativeSource, providerSource] = await Promise.all([
      readFile(new URL('../../../native/linux/runtime.py', import.meta.url), 'utf8'),
      readFile(new URL('../../../packages/platform-linux/src/index.ts', import.meta.url), 'utf8')
    ])
    expect(nativeSource).toContain('"code": "screenshot_failed"')
    expect(providerSource).toContain('issues: normalizeScreenshotIssues(raw.screenshotError)')
    expect(providerSource).toContain('freshState: normalizedSnapshot')
  })
})
