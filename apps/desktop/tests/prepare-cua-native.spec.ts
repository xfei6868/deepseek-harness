import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { prepareDesktopCuaNative } from '../scripts/prepare-cua-native.ts'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => Buffer.alloc(0)) }))
afterEach(() => { vi.clearAllMocks() })

function fixture(arch: 'arm64' | 'x64') {
  const root = mkdtempSync(join(tmpdir(), 'desktop-cua-native-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const scratch = join(root, 'build')
  const source = join(scratch, 'release', 'dsh-cua-native')
  const output = join(root, 'native', 'bin', `darwin-${arch}`, 'dsh-cua-native')
  mkdirSync(join(scratch, 'release'), { recursive: true })
  writeFileSync(source, 'compiled helper')
  return { root, scratch, source, output }
}

it.each(['arm64', 'x64'] as const)('publishes a verified %s helper with executable permissions', (arch) => {
  const f = fixture(arch)
  prepareDesktopCuaNative(f.root, f.scratch, arch)
  const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
  const calls = vi.mocked(execFileSync).mock.calls
  expect(calls[0]?.[1]).toEqual(['swift', 'build', '--package-path', join(f.root, 'native'),
    '--scratch-path', f.scratch, '--configuration', 'release', '--product', 'dsh-cua-native', '--arch', cpu])
  expect(calls[1]?.slice(0, 2)).toEqual(['/usr/bin/lipo', [f.source, '-verify_arch', cpu]])
  expect(readFileSync(f.output, 'utf8')).toBe('compiled helper')
  if (process.platform !== 'win32') expect(statSync(f.output).mode & 0o777).toBe(0o755)
  expect(readdirSync(join(f.output, '..'))).toEqual(['dsh-cua-native'])
})

it.each(['compiler', 'architecture'] as const)('preserves the previous helper when %s verification fails', (stage) => {
  const f = fixture('x64')
  mkdirSync(join(f.output, '..'), { recursive: true })
  writeFileSync(f.output, 'previous helper')
  if (stage === 'architecture') vi.mocked(execFileSync).mockReturnValueOnce(Buffer.alloc(0))
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error(`${stage} failed`) })
  expect(() => { prepareDesktopCuaNative(f.root, f.scratch, 'x64') }).toThrow(`${stage} failed`)
  expect(readFileSync(f.output, 'utf8')).toBe('previous helper')
  expect(readdirSync(join(f.output, '..'))).toEqual(['dsh-cua-native'])
})

it('does not publish a helper when the compiler produces no executable', () => {
  const f = fixture('x64')
  rmSync(f.source)
  expect(() => { prepareDesktopCuaNative(f.root, f.scratch, 'x64') }).toThrow()
  expect(existsSync(f.output)).toBe(false)
  expect(readdirSync(join(f.output, '..'))).toEqual([])
})
