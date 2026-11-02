/** Build the target macOS Computer Use helper before its package enters Desktop resources. */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'

/**
 * Compile and atomically publish a helper only after lipo verifies the requested architecture.
 * A compiler or architecture failure leaves the previous helper unchanged and rejects preparation.
 * @param packageRoot - Source directory of the macOS Computer Use provider.
 * @param scratch - Target-owned Swift build directory.
 * @param arch - Architecture of the Desktop runtime that will execute the helper.
 */
export function prepareDesktopCuaNative(packageRoot: string, scratch: string, arch: 'arm64' | 'x64'): void {
  const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
  execFileSync('/usr/bin/xcrun', ['swift', 'build', '--package-path', join(packageRoot, 'native'),
    '--scratch-path', scratch, '--configuration', 'release', '--product', 'dsh-cua-native', '--arch', cpu],
  { stdio: 'inherit', timeout: 600_000 })
  const source = join(scratch, 'release', 'dsh-cua-native')
  execFileSync('/usr/bin/lipo', [source, '-verify_arch', cpu], { stdio: 'inherit', timeout: 30_000 })
  const destination = join(packageRoot, 'native', 'bin', `darwin-${arch}`, 'dsh-cua-native')
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = mkdtempSync(join(dirname(destination), '.prepared-'))
  try {
    const pending = join(temporary, 'dsh-cua-native')
    copyFileSync(source, pending)
    chmodSync(pending, 0o755)
    renameSync(pending, destination)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const target = desktopTargetPlatform(resolveDesktopBuildTarget())
  if (target.platform !== 'darwin') throw new Error('Computer Use helper preparation requires a macOS target')
  prepareDesktopCuaNative(resolve(import.meta.dirname, '../../../packages/experimental/cua-macos'),
    join(resolveDesktopTargetBuildPaths().root, 'cua-native'), target.arch)
}
