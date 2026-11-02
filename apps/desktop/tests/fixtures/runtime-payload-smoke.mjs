/** Exercise filtered Desktop native and HTML dependencies under its Electron Node runtime. */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPnpm } from './pnpm-smoke.mjs'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass the filtered resources/dsh directory')
const root = resolve(runtime)
const descriptor = JSON.parse(readFileSync(join(root, 'desktop-runtime.json'), 'utf8'))
assert.equal(process.versions.node, descriptor.release.nodeVersion, 'Run with the Electron Node runtime version')
assert.equal(process.platform, descriptor.platform)
assert.equal(process.arch, descriptor.arch)
const resourcesRuntime = process.argv[3] ?? join(dirname(root), 'runtime')
const requireRuntime = createRequire(join(root, 'package.json'))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-payload-'))

/** Spawn only a fixed Node program and await the terminal's drained exit event. */
async function checkPty() {
  const pty = requireRuntime('node-pty')
  const script = join(scratch, 'pty.cjs')
  writeFileSync(script, "process.stdout.write('runtime-payload-pty-ok\\n')\n", { flag: 'wx', mode: 0o600 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    /^(?:path|systemroot|windir|comspec|ELECTRON_RUN_AS_NODE)$/iu.test(name)
  )))
  Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch })
  env.DSH_DESKTOP_NODE_EXECUTABLE = process.execPath
  env.PATH = `${join(resourcesRuntime, 'bin')}${delimiter}${env.PATH ?? env.Path ?? ''}`
  // A Windows GUI executable needs a console-owning shell when launched inside ConPTY.
  const executable = process.platform === 'win32' ? process.env.ComSpec : process.execPath
  const args = process.platform === 'win32' ? ['/d', '/c', 'node', script] : [script]
  // Mirror the product's Windows allocation: the console host node-pty ships.
  const terminal = pty.spawn(executable, args, {
    cwd: scratch, env, cols: 80, rows: 24,
    ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
  })
  let output = ''
  let exited = false
  let timedOut = false
  let exitSubscription
  const exit = new Promise(resolveExit => {
    exitSubscription = terminal.onExit(event => {
      exited = true
      resolveExit(event)
    })
  })
  const dataSubscription = terminal.onData(data => { output += data })
  let timer
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('Packaged PTY did not exit within 45 seconds'))
      }, 45_000)
    })
    const result = await Promise.race([exit, deadline])
    assert.equal(timedOut, false)
    assert.ok(result.signal === undefined || result.signal === 0, 'PTY exited without a signal')
    assert.equal(result.exitCode, 0)
    assert.match(output, /runtime-payload-pty-ok/u)
  } finally {
    clearTimeout(timer)
    dataSubscription.dispose()
    try {
      // node-pty's Windows natural-exit event closes output but leaves its ConPTY worker owned by kill().
      if (!exited || process.platform === 'win32') terminal.kill()
      await exit
    } finally {
      exitSubscription.dispose()
    }
  }
}

/** Exercise grep and glob operations with the search tool's resolved native executable. */
async function checkSearch() {
  const { resolveRgPath } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-tool-fs-search')).href)
  const executable = await resolveRgPath()
  const name = 'ripgrep-smoke.txt'
  const marker = 'desktop-ripgrep-smoke'
  writeFileSync(join(scratch, name), `${marker}\n`, { flag: 'wx', mode: 0o600 })
  const run = args => execFileSync(executable, ['--no-config', ...args], {
    cwd: scratch, encoding: 'utf8', timeout: 45_000, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:systemroot|windir)$/iu.test(name))),
  }).trim().replaceAll('\\', '/')
  assert.equal(run(['--no-heading', '--no-filename', '--line-number', '--fixed-strings', '--', marker, name]), `1:${marker}`)
  assert.equal(run(['--files', '--glob', name, '.']), `./${name}`)
}

/** Acquire and release the packaged POSIX lock used by atomic file operations. */
async function checkFlock() {
  if (process.platform === 'win32') return
  const { tryLockExclusive } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/node-addon-system/flock')).href)
  const file = join(scratch, 'flock')
  const owner = await open(file, 'wx', 0o600)
  try {
    await tryLockExclusive(owner.fd)
    const contender = await open(file, 'r+')
    try {
      await assert.rejects(tryLockExclusive(contender.fd), error => error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')
    } finally { await contender.close() }
  } finally { await owner.close() }
  const successor = await open(file, 'r+')
  try { await tryLockExclusive(successor.fd) } finally { await successor.close() }
}

/** Resolve one system function through Koffi's packaged native module. */
function checkKoffi() {
  const koffi = requireRuntime('koffi')
  const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null)
  try {
    const getPid = process.platform === 'win32'
      ? library.func('uint32_t __stdcall GetCurrentProcessId(void)')
      : library.func('int getpid(void)')
    assert.equal(getPid(), process.pid)
  } finally {
    library.unload()
  }
}

/** Reject incomplete startup arguments before the native helper can create a server or request permissions. */
function checkCua() {
  if (process.platform !== 'darwin') return
  const provider = dirname(requireRuntime.resolve('@deepseek-ai/dsh-experimental-cua-macos/package.json'))
  const physical = provider.replace(/(^|[/\\])([^/\\]+\.asar)(?=[/\\]|$)/u, '$1$2.unpacked')
  const helper = realpathSync(join(physical, 'native', 'bin', `darwin-${process.arch}`, 'dsh-cua-native'))
  const result = spawnSync(helper, ['--ensure-shared'], { encoding: 'utf8', timeout: 45_000 })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null, 'Computer Use helper exited without a signal')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /dsh-cua-native: Shared helper requires SHA-256 runtime key/u)
}

/** Decode generated PCM through the speech provider's native binding without models or microphone access. */
function checkSpeech() {
  const provider = requireRuntime.resolve('@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/package.json')
  const sherpa = createRequire(provider)('sherpa-onnx-node')
  assert.equal(typeof sherpa.OfflineRecognizer, 'function')
  assert.equal(typeof sherpa.Vad, 'function')
  const wave = Buffer.alloc(48)
  wave.write('RIFF', 0)
  wave.writeUInt32LE(40, 4)
  wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16)
  wave.writeUInt16LE(1, 20)
  wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(16000, 24)
  wave.writeUInt32LE(32000, 28)
  wave.writeUInt16LE(2, 32)
  wave.writeUInt16LE(16, 34)
  wave.write('data', 36)
  wave.writeUInt32LE(4, 40)
  wave.writeInt16LE(1024, 44)
  wave.writeInt16LE(-2048, 46)
  const file = join(scratch, 'speech.wav')
  writeFileSync(file, wave, { flag: 'wx' })
  const audio = sherpa.readWave(file, false)
  assert.equal(audio.sampleRate, 16000)
  assert.deepEqual(Array.from(audio.samples), [1024 / 32768, -2048 / 32768])
}

/** Encode and decode a pixel through the packaged libvips binary. */
async function checkSharp() {
  const sharp = requireRuntime('sharp')
  const pixel = Buffer.from([17, 103, 231])
  const png = await sharp(pixel, { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer()
  const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  assert.equal(decoded.info.width, 1)
  assert.equal(decoded.info.height, 1)
  assert.equal(decoded.info.channels, 3)
  assert.deepEqual(decoded.data, pixel)
}

/** Exercise Domino parsing through the HTML converter and GFM plugin used by web_fetch. */
function checkHtml() {
  const Turndown = requireRuntime('turndown')
  const { gfm } = requireRuntime('@joplin/turndown-plugin-gfm')
  const converter = new Turndown({ bulletListMarker: '-' })
  converter.use(gfm)
  const markdown = converter.turndown('<p>A &amp; B &copy;</p><ul><li>first</li><li>second</li></ul>'
    + '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>x</td><td>7</td></tr></tbody></table>')
  assert.match(markdown, /A & B ©/u)
  assert.match(markdown, /-\s+first\n-\s+second/u)
  assert.match(markdown, /\| Name \| Value \|/u)
  assert.match(markdown, /\| x\s+\| 7\s+\|/u)
}

try {
  const builtin = requireRuntime('node-addon-require-builtin')
  assert.equal(typeof builtin.requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
  console.error('runtime payload: pnpm')
  await checkPnpm(resourcesRuntime)
  console.error('runtime payload: koffi')
  checkKoffi()
  console.error('runtime payload: sharp')
  await checkSharp()
  console.error('runtime payload: html')
  checkHtml()
  console.error('runtime payload: pty')
  await checkPty()
  console.error('runtime payload: search')
  await checkSearch()
  console.error('runtime payload: flock')
  await checkFlock()
  console.error('runtime payload: cua')
  checkCua()
  console.error('runtime payload: speech')
  checkSpeech()
  console.error('runtime payload: checks complete; awaiting process exit')
} finally {
  // This private tree contains only fixture files; Windows may release handles after terminal exit.
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

// Natural event-loop drain includes node-pty's worker and console-list helper teardown.
process.once('beforeExit', () => {
  console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch,
    koffi: true, sharp: true, html: true, pty: true, pnpm: true, grep: true, glob: true,
    flock: process.platform !== 'win32', cua: process.platform === 'darwin', speech: true }))
})
