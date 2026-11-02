/** Desktop preparation delegates bundle publication to the provider's native builder. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { prepareDesktopCuaNative } from '../scripts/prepare-cua-native.ts'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => Buffer.alloc(0)) }))
afterEach(() => { vi.resetAllMocks() })
function fixture(arch: 'arm64' | 'x64') {
  const root = mkdtempSync(join(tmpdir(), 'desktop-cua-native-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const directory = join(root, 'native/bin', `darwin-${arch}`)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'current.json'), JSON.stringify({ bundle: 'a'.repeat(64) }))
  return { root, directory, scratch: join(root, 'build') }
}
it.each(['arm64', 'x64'] as const)('prepares and verifies the signed %s application', (arch) => {
  const f = fixture(arch)
  prepareDesktopCuaNative(f.root, f.scratch, arch, 'Developer ID Application: Example')
  const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
  expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toEqual(['python3', join(f.root, 'native/build_app.py'),
    '--scratch-path', f.scratch, '--output-directory', f.directory, '--arch', cpu, '--identity', 'Developer ID Application: Example'])
  expect(vi.mocked(execFileSync).mock.calls[1]?.[1]).toEqual([
    join(f.directory, 'a'.repeat(64), 'DSH Computer Use.app/Contents/MacOS/dsh-cua-native'), '-verify_arch', cpu])
})
it('uses local ad-hoc signing when no release identity is supplied', () => {
  const f = fixture('x64')
  prepareDesktopCuaNative(f.root, f.scratch, 'x64')
  expect(vi.mocked(execFileSync).mock.calls[0]?.[1]).toContain('-')
})
it('stops preparation when the native builder fails', () => {
  const f = fixture('x64')
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('native build failed') })
  expect(() => { prepareDesktopCuaNative(f.root, f.scratch, 'x64') }).toThrow('native build failed')
  expect(execFileSync).toHaveBeenCalledTimes(1)
})
it('rejects an invalid application generation before verifying an executable', () => {
  const f = fixture('x64')
  writeFileSync(join(f.directory, 'current.json'), JSON.stringify({ bundle: '../outside' }))
  expect(() => { prepareDesktopCuaNative(f.root, f.scratch, 'x64') }).toThrow('receipt is invalid')
  expect(execFileSync).toHaveBeenCalledTimes(1)
})
