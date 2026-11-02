/** Prepare the target Computer Use application before packing Desktop resources. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { desktopTargetPlatform, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { resolveMacOSSigningEnvironment } from './desktop-release-environment.mjs'

/**
 * Build and sign the provider-owned application, then verify its target architecture.
 * The provider publishes its immutable generation and receipt atomically.
 * @param packageRoot - Source directory of the macOS Computer Use provider.
 * @param scratch - Target-owned Swift build directory.
 * @param arch - Architecture of the Desktop runtime.
 * @param identity - Signing identity; a hyphen selects a local ad-hoc build.
 */
export function prepareDesktopCuaNative(packageRoot: string, scratch: string, arch: 'arm64' | 'x64', identity = '-'): void {
  const cpu = arch === 'x64' ? 'x86_64' : 'arm64'
  const destination = join(packageRoot, 'native', 'bin', `darwin-${arch}`)
  execFileSync('/usr/bin/xcrun', ['python3', join(packageRoot, 'native', 'build_app.py'),
    '--scratch-path', scratch, '--output-directory', destination, '--arch', cpu, '--identity', identity],
  { stdio: 'inherit', timeout: 600_000 })
  const receipt = JSON.parse(readFileSync(join(destination, 'current.json'), 'utf8')) as { bundle?: unknown }
  if (typeof receipt.bundle !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.bundle)) throw new Error('Computer Use application receipt is invalid')
  const executable = join(destination, receipt.bundle, 'DSH Computer Use.app', 'Contents', 'MacOS', 'dsh-cua-native')
  execFileSync('/usr/bin/lipo', [executable, '-verify_arch', cpu], { stdio: 'inherit', timeout: 30_000 })
}

if (import.meta.main) {
  const target = desktopTargetPlatform(resolveDesktopBuildTarget())
  if (target.platform !== 'darwin') throw new Error('Computer Use helper preparation requires a macOS target')
  const identity = process.env.DSH_DESKTOP_UNSIGNED === '1' ? '-' : resolveMacOSSigningEnvironment(process.env).signingIdentity
  prepareDesktopCuaNative(resolve(import.meta.dirname, '../../../packages/experimental/cua-macos'),
    join(resolveDesktopTargetBuildPaths().root, 'cua-native'), target.arch, identity)
}
