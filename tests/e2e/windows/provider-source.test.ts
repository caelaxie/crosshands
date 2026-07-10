import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const runtimePath = resolve('native/windows/runtime.ps1')
const runtimeSource = readFile(runtimePath, 'utf8')
const relayBuildSource = readFile(resolve('native/windows/security/build.cmd'), 'utf8')

describe('Windows native provider characterization', () => {
  it('uses persistent stdin frames and never accepts an operation path', async () => {
    const source = await runtimeSource
    expect(source).toContain('[Console]::In.ReadLine()')
    expect(source).toContain('ConvertFrom-Json')
    expect(source).not.toContain('$OperationPath')
    expect(source).not.toContain('Get-Content -Raw')
  })

  it('bounds and redacts UI Automation discovery before serialization', async () => {
    const source = await runtimeSource
    expect(source).toContain('$MaxNodes = 1200')
    expect(source).toContain('$MaxDepth = 64')
    expect(source).toContain('if ($Element.Current.IsPassword)')
    expect(source).toContain('return "[redacted]"')
    expect(source).toContain('$MaxScreenshotPngBytes = 900000')
    expect(source).toContain('CrossHandsDesktopWin32]::PrintWindow')
    expect(source).not.toContain('CopyFromScreen')
    expect(source).toContain('target-window screenshot capture failed')
  })

  it('tries UI Automation patterns before any synthetic click fallback', async () => {
    const source = await runtimeSource
    const invoke = source.indexOf('Invoke-CrossHandsPrimaryAction $element')
    const fallback = source.indexOf('Send-CrossHandsMouseClick $handle', invoke)
    expect(invoke).toBeGreaterThan(0)
    expect(fallback).toBeGreaterThan(invoke)
    expect(source).toContain('[Windows.Automation.ValuePattern]::Pattern')
    expect(source).toContain('value_pattern_readback')
  })

  it('fails closed across lock, secure desktop, RDP, session and integrity transitions', async () => {
    const source = await runtimeSource
    expect(source).toContain('OpenInputDesktop')
    expect(source).toContain('GetSystemMetrics(0x1000)')
    expect(source).toContain('$desktop -ine "Default"')
    expect(source).toContain('$actual.sessionId -ne')
    expect(source).toContain('$actual.integrityRid -ne $selfIntegrity')
    expect(source).toContain(
      'Assert-CrossHandsProcessIdentity $process $Operation.expectedIdentity'
    )
  })

  it('binds PID reuse and lookalikes to full executable provenance', async () => {
    const source = await runtimeSource
    for (const field of [
      'pid',
      'startedAt',
      'sessionId',
      'desktop',
      'executablePath',
      'integrityRid',
      'publisher',
      'sha256'
    ]) {
      expect(source).toContain(`"${field}"`)
    }
    expect(source).toContain('Get-AuthenticodeSignature')
    expect(source).toContain('[System.Security.Cryptography.SHA256]::Create()')
  })

  it('keeps Unicode, modifier, clipboard, multi-monitor and mixed-DPI behavior bounded', async () => {
    const source = await runtimeSource
    expect(source).toContain('$WindowsMessages.Char')
    expect(source).toContain('ConvertTo-CrossHandsSendKeysModifier')
    expect(source).toContain('[System.Windows.Forms.Clipboard]::SetDataObject($previous, $true)')
    expect(source).toContain('SetCursorPos')
    expect(source).toContain('SetProcessDpiAwarenessContext([IntPtr](-4))')
    expect(source).toContain('Wait-CrossHandsWindowFocused')
  })

  it('keeps the packaged payload byte-identical to the reviewed native source', async () => {
    const [source, packaged] = await Promise.all([
      readFile(runtimePath),
      readFile(resolve('packages/platform-windows/assets/runtime.ps1'))
    ])
    expect(packaged).toEqual(source)
  })

  it('discovers fixed Visual Studio editions before locator fallbacks', async () => {
    const source = await relayBuildSource
    expect(source).toContain('setlocal EnableExtensions EnableDelayedExpansion')
    expect(source).toContain('if not exist "!VSINSTALL!\\VC\\Auxiliary\\Build\\vcvars64.bat"')
    expect(source).toContain('for /f "usebackq delims=" %%I in (`"!VSWHERE!"')
    expect(source).toContain('%ProgramFiles%\\Microsoft Visual Studio\\2022\\Enterprise')
    expect(source).toContain('%ProgramFiles%\\Microsoft Visual Studio\\2022\\BuildTools')
    expect(source).toContain('%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe')
    expect(source).toContain('%ProgramFiles%\\Microsoft Visual Studio\\Installer\\vswhere.exe')
    expect(source).toContain('%ChocolateyInstall%\\bin\\vswhere.exe')
  })
})
