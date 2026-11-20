// What the command line itself adds to a check error: where it is printed,
// and the calls an error inside an instance of a generic was required from.
// What the checker reports is tested in the compiler package.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CLI = join(import.meta.dir, 'cli.ts')

// `max` is instantiated for a struct, which has no `>`: one error, inside the
// instance, with the call in `f` as the place it was required from.
const SHAPES = `type Pt = (q: i32, r: i32)
func max(comptime T: type, a: T, b: T) -> T => if a > b { a } else { b }

export func f(a: Pt, b: Pt) -> Pt => max(a, b)
`

// Runs `encantis <command> <file> [flags]` on SHAPES written to a file.
async function encantis(command: string, ...flags: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
  try {
    const file = join(dir, 'shapes.ents')
    await writeFile(file, SHAPES)
    const run = Bun.spawnSync([process.execPath, CLI, command, file, ...flags])
    return { file, exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
  } finally {
    await rm(dir, { recursive: true })
  }
}

describe('check errors on the command line', () => {
  const message = "'>' cannot be applied to Pt and Pt, in max(T = Pt)"

  test('an error inside an instance is followed by the calls it was required from', async () => {
    const { file, exitCode, stderr } = await encantis('check')
    expect(exitCode).toBe(1)
    expect(stderr).toBe(`${file}:2:51: ${message}\n  required from ${file}:4:38\n`)
  })

  test('check --json carries them as notes', async () => {
    const { file, exitCode, stdout } = await encantis('check', '--json')
    expect(exitCode).toBe(1)
    expect(JSON.parse(stdout)).toEqual([
      { file, line: 2, col: 51, message, notes: [{ file, line: 4, col: 38, message: 'required from' }] },
    ])
  })

  // One printer serves every command that checks before it does its work.
  for (const command of ['compile', 'wasm', 'test', 'run']) {
    test(`${command} prints the same lines`, async () => {
      const { file, exitCode, stderr } = await encantis(command)
      expect(exitCode).toBe(1)
      expect(stderr).toContain(`${file}:2:51: ${message}\n  required from ${file}:4:38\n`)
    })
  }
})

// meta.json names the file it is of by the file's name, on every platform.
test('meta names its file', async () => {
  const { stdout } = await encantis('meta')
  expect(JSON.parse(stdout).src).toBe('file://./shapes.ents')
})

// A library that checks on its own, used by a module whose type it cannot
// serve: the error is in the library's generic, found only once the other
// module asks for the instance, after the library was checked. It stops the
// build, and the call that asked is said where it is, in the other file.
describe('check errors across modules', () => {
  const LIB = `export func bucket(comptime K: type, k: K, n: u32) -> u32 => hash(k) % n
func hash(k: u32) -> u32 => k * 0x45d9f3b
`
  const MAIN = `import "./lib" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32
export func f(x: f64) -> u32 => bucket(x, 16)
`
  const lib = "no function 'hash' accepts (f64), in bucket(K = f64)"
  const main = `bucket(K = f64) cannot be instantiated: no function 'hash' accepts (f64) (lib.ents:1:62)`

  async function run(command: string, ...flags: string[]) {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
    try {
      await writeFile(join(dir, 'lib.ents'), LIB)
      await writeFile(join(dir, 'main.ents'), MAIN)
      const run = Bun.spawnSync([process.execPath, CLI, command, join(dir, 'main.ents'), ...flags])
      return { dir, exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
    } finally {
      await rm(dir, { recursive: true })
    }
  }

  test("the note is in the file of the call that asked, and that call has an error of its own", async () => {
    const { dir, exitCode, stderr } = await run('check')
    expect(exitCode).toBe(1)
    expect(stderr).toBe(`${join(dir, 'lib.ents')}:1:62: ${lib}\n  required from ${join(dir, 'main.ents')}:2:33\n${join(dir, 'main.ents')}:2:33: ${main}\n`)
  })

  test('check --json carries the note with its file', async () => {
    const { dir, stdout } = await run('check', '--json')
    expect(JSON.parse(stdout)).toEqual([
      { file: join(dir, 'lib.ents'), line: 1, col: 62, message: lib, notes: [{ file: join(dir, 'main.ents'), line: 2, col: 33, message: 'required from' }] },
      { file: join(dir, 'main.ents'), line: 2, col: 33, message: main },
    ])
  })

  test('a query on a file that imports a generic answers from its program', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
    try {
      await writeFile(join(dir, 'lib.ents'), LIB)
      await writeFile(join(dir, 'main.ents'), `${MAIN}export func g(x: u32) -> u32 => x.bucket(16)\n`)
      const run = Bun.spawnSync([process.execPath, CLI, 'hover', `${join(dir, 'main.ents')}:3:35`])
      expect(run.stdout.toString()).toBe('generic bucket: func(k: u32, n: u32) -> u32 — bucket(x, 16); calls bucket(K = u32)\n')
    } finally {
      await rm(dir, { recursive: true })
    }
  })

  // A function of this module that another module's generic calls by its
  // name is found there, and renaming it here would leave that call with
  // nothing to find. The other file is named relative to the working
  // directory also where that directory is reached through a symbolic link,
  // as macOS's temporary directory is (/var is /private/var): the file was
  // named from the root.
  test("references find another module's instance calling the function, and rename refuses", async () => {
    const real = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
    const dir = `${real}-link`
    await symlink(real, dir, 'junction')
    try {
      await writeFile(join(dir, 'lib.ents'), 'export func bucket(comptime K: type, k: K, n: u32) -> u32 => hash(k) % n\n')
      await writeFile(join(dir, 'main.ents'), 'import "./lib" "bucket" func bucket(comptime K: type, k: K, n: u32) -> u32\nfunc hash(k: f64) -> u32 => 7\nexport func f(x: f64) -> u32 => bucket(x, 16)\n')
      const at = `${join(dir, 'main.ents')}:2:6`
      const references = Bun.spawnSync([process.execPath, CLI, 'references', at, '--json'], { cwd: dir })
      expect(JSON.parse(references.stdout.toString())).toEqual([{ file: 'lib.ents', line: 1, col: 62 }])
      const rename = Bun.spawnSync([process.execPath, CLI, 'rename', at, '--json'], { cwd: dir })
      expect(rename.exitCode).toBe(1)
      expect(rename.stderr.toString()).toBe("'hash' is called by its name from instances of other modules' generics (bucket(K = f64) in lib.ents): renamed, they would no longer find it\n")
    } finally {
      await unlink(dir)
      await rm(real, { recursive: true })
    }
  })

  for (const command of ['compile', 'wasm']) {
    test(`${command} stops at the error in the module checked first`, async () => {
      const { exitCode, stdout, stderr } = await run(command)
      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain(lib)
    })
  }
})

// The queries answer for the name where it stands: a local where it is
// defined, the binding of an if let at its name, each name of a for, and a
// field as a field. Before, each was looked up by name, and a rename from one
// edited another (what the query layer answers is tested in the compiler
// package).
describe('editor queries on the command line', () => {
  const PROGRAM = `global x: u32 = 7
type Pt = (x: i32, y: i32)
export func f(p: Pt, xs: []u32, o: ?*u32) -> u32 {
  let s = p.x as u32
  for i, v in xs {
    s += v * i
  }
  if let q = o {
    s += q.*
  }
  for i in 3 {
    s += i
  }
  return s + x
}
`
  async function query(command: string, line: number, col: number, ...flags: string[]) {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
    try {
      const file = join(dir, 'names.ents')
      await writeFile(file, PROGRAM)
      const run = Bun.spawnSync([process.execPath, CLI, command, `${file}:${line}:${col}`, ...flags])
      return { file, exitCode: run.exitCode, stdout: run.stdout.toString() }
    } finally {
      await rm(dir, { recursive: true })
    }
  }

  test('a local defined twice in a function is found from each definition', async () => {
    const first = await query('references', 5, 7)
    expect(first.stdout).toBe(`${first.file}:6:14\n`)
    const second = await query('definition', 12, 10)
    expect(second.stdout).toBe(`${second.file}:11:7 i\n`)
  })

  test('renaming the binding of an if let leaves the value it is taken from', async () => {
    const { file, stdout } = await query('rename', 8, 10, '--json')
    expect(JSON.parse(stdout)).toEqual({
      oldName: 'q',
      locations: [{ file, line: 8, col: 10, length: 1 }, { file, line: 9, col: 10, length: 1 }],
    })
  })

  test('the index and the value of a for are renamed apart', async () => {
    const { file, stdout } = await query('rename', 5, 10)
    expect(stdout).toBe(`v: 2 locations\n  ${file}:5:10\n  ${file}:6:10\n`)
    expect((await query('hover', 5, 7)).stdout).toBe('local i: u32\n')
  })

  test('a field named like a global is not the global', async () => {
    expect((await query('hover', 2, 12)).stdout).toBe('No info\n')
    expect((await query('rename', 2, 12)).stdout).toBe('No symbol found\n')
    expect((await query('hover', 4, 13)).stdout).toBe('field x: i32\n')
    const global = await query('rename', 1, 8)
    expect(global.stdout).toBe(`x: 2 locations\n  ${global.file}:1:8\n  ${global.file}:14:14\n`)
  })
})

// In a generic's body a name is what it is in each instance: hover prints the
// type it is declared with and its type in each instance, and references
// from one of several functions of a name list the calls that call it.
describe('generics on the command line', () => {
  const PROGRAM = `func eq(a: u32, b: u32) -> bool => a == b
func eq(a: f64, b: f64) -> bool => a == b
func eq(a: i64, b: i64) -> bool => a == b
func index_of(comptime T: type, xs: []T, x: T) -> u32 {
  for i, y in xs {
    return i when eq(y, x)
  }
  return xs.len
}
data us = [1:u32, 2, 3]
data fs = [1.0:f64, 2.0]
export func f() -> u32 => index_of(us, 2) + index_of(fs, 2.0)
`
  async function query(command: string, at: string, ...flags: string[]) {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
    try {
      const file = join(dir, 'generic.ents')
      await writeFile(file, PROGRAM)
      const run = Bun.spawnSync([process.execPath, CLI, command, `${file}:${at}`, ...flags])
      return { file, exitCode: run.exitCode, stdout: run.stdout.toString() }
    } finally {
      await rm(dir, { recursive: true })
    }
  }

  test('hover in a generic\'s body', async () => {
    expect((await query('hover', '4:42')).stdout).toBe('local x: T — in index_of(T = u32): u32; in index_of(T = f64): f64\n')
    expect((await query('hover', '4:24')).stdout).toBe('type parameter T: type — in index_of(T = u32): u32; in index_of(T = f64): f64\n')
    expect((await query('hover', '6:19')).stdout).toBe(
      'func eq: func(a: u32, b: u32) -> bool — in index_of(T = u32): eq(a: u32, b: u32) -> bool; in index_of(T = f64): eq(a: f64, b: f64) -> bool\n',
    )
    expect((await query('hover', '12:45')).stdout).toBe('generic index_of: func(xs: []f64, x: f64) -> u32 — calls index_of(T = f64)\n')
    expect(JSON.parse((await query('hover', '4:42', '--json')).stdout)).toEqual({
      name: 'x', type: 'T', kind: 'local', instances: [{ in: ['index_of(T = u32)'], type: 'u32' }, { in: ['index_of(T = f64)'], type: 'f64' }],
    })
  })

  test('references from one of several functions of a name', async () => {
    const u32 = await query('references', '1:6')
    expect(u32.stdout).toBe(`${u32.file}:6:19\n`)
    // No instance has T = i64.
    expect((await query('references', '3:6')).stdout).toBe('')
    const call = await query('definition', '6:19')
    expect(call.stdout).toBe(`${call.file}:1:1 eq\n`)
  })
})

// `wasm -O` and `wasm --release` optimize with binaryen in this process, the
// version package.json pins (wasm.ts). The program returns a struct of three
// u64 as three values, which binaryen's -Oz grows (today 146 bytes
// unoptimized, 158 with -O, 136 with --release), and fills memory with
// memory.fill (bulk memory).
describe('optimized builds', () => {
  const PROGRAM = `type P = (x: u64, y: u64, z: u64)
export func add(a: P, b: P) -> P => (a.x + b.x, a.y + b.y, a.z + b.z)
export func dbl(a: P) -> P => add(add(a, a), add(a, a))

data buf = mut [0:u8; 64]
export func clear() {
  buf[..] = 0
}
`
  const root = join(import.meta.dir, '../../..')
  const binaryenPath = Bun.resolveSync('binaryen', root)
  const binaryenVersion = JSON.parse(readFileSync(join(binaryenPath, '../package.json'), 'utf8')).version

  // `encantis wasm <file> -o <dir>/out.wasm [flags]` on PROGRAM, or on an
  // example; `preload` is a script bun runs before the command.
  async function wasm(flags: string[], { example = '', preload = '' } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
    try {
      const file = example ? join(root, example) : join(dir, 'program.ents')
      if (!example) await writeFile(file, PROGRAM)
      const pre: string[] = []
      if (preload) {
        await writeFile(join(dir, 'preload.ts'), preload)
        pre.push('--preload', join(dir, 'preload.ts'))
      }
      const out = join(dir, 'out.wasm')
      const run = Bun.spawnSync([process.execPath, ...pre, CLI, 'wasm', file, '-o', out, ...flags])
      const written = existsSync(out) ? new Uint8Array(readFileSync(out)) : null
      return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString(), written }
    } finally {
      await rm(dir, { recursive: true })
    }
  }

  // A host reference is an externref, which binaryen takes (reference
  // types are among its features) and keeps: the release build still hands
  // the host's values back as they came.
  test('--release keeps host references', async () => {
    const { exitCode, written } = await wasm(['--release'], { example: 'examples/types/host.ents' })
    expect(exitCode).toBe(0)
    const shown: unknown[][] = []
    const stopped: unknown[] = []
    const timer = { name: 'timer' }
    const { instance } = await WebAssembly.instantiate(written as Uint8Array, {
      dom: { show: (e: unknown, n: number) => shown.push([e, n]), every: () => timer, stop: (t: unknown) => stopped.push(t) },
    })
    const label = { name: 'label' }
    const exports = instance.exports as Record<string, CallableFunction>
    exports.mount(label)
    for (let i = 0; i < 10; i++) exports.tick()
    expect(shown[0]).toEqual([label, 0])
    expect(shown[10][0]).toBe(label)
    expect(stopped).toEqual([timer])
    expect(stopped[0]).toBe(timer)
  })

  // --version names the binaryen it optimizes with: two builds are of the
  // same tools when their versions say the same.
  test('--version names binaryen', () => {
    const run = Bun.spawnSync([process.execPath, CLI, '--version'])
    expect(run.stdout.toString()).toBe(`encantis dev (binaryen ${binaryenVersion})\n`)
  })

  // The same source and the same encantis give the same bytes: nothing in a
  // release build depends on the run (an example with imports and generics).
  test('--release twice gives the same bytes', async () => {
    const example = 'examples/containers/main.ents'
    const first = await wasm(['--release'], { example })
    const second = await wasm(['--release'], { example })
    expect(first.exitCode).toBe(0)
    expect(first.written?.length).toBeGreaterThan(0)
    expect(second.written).toEqual(first.written)
  }, 60_000)

  // --release is never larger than the module unoptimized, nor than -O's.
  // --size --json says each size, and the optimized one is the file's.
  test('--release keeps the smallest module, and --size --json says how big it is', async () => {
    const optimize = await wasm(['-O', '--size', '--json'])
    const release = await wasm(['--release', '--size', '--json'])
    const o = JSON.parse(optimize.stdout)
    const r = JSON.parse(release.stdout)
    expect(o.optimized).toBe(optimize.written?.length)
    expect(r.optimized).toBe(release.written?.length)
    expect(r.unoptimized).toBe(o.unoptimized)
    expect(r.optimized).toBeLessThanOrEqual(Math.min(o.unoptimized, o.optimized))
    expect(r.gzip).toBeGreaterThan(0)
    expect(r.brotli).toBeGreaterThan(0)
  }, 60_000)

  // As text, a name and a number a line, the optimized size with its change;
  // a build that does not optimize has no optimized line.
  test('--size as text', async () => {
    const plain = await wasm(['--size'])
    expect(plain.stdout).toMatch(new RegExp(`^unoptimized  ${plain.written?.length}\ngzip {9}\\d+\nbrotli {7}\\d+\n$`))
    const optimized = await wasm(['-O', '--size'])
    expect(optimized.stdout).toMatch(/^unoptimized {2}\d+\noptimized {4}\d+ {2}[-+]?\d+\.\d%\ngzip {9}\d+\nbrotli {7}\d+\n$/)
  }, 60_000)

  // binaryen as a preloaded script gives it to the command: not there,
  // refusing the module (it does not validate without multi-value and bulk
  // memory), or throwing (binaryen aborts on memory.fill when asked for bulk
  // memory without bulk-memory-opt).
  const fakeBinaryen = (how: 'missing' | 'invalid' | 'throws') => {
    const real = how === 'missing' ? 'null' : `(await import(${JSON.stringify(pathToFileURL(binaryenPath).href)})).default`
    const features = how === 'invalid' ? 'BulkMemory: 0, BulkMemoryOpt: 0, Multivalue: 0' : 'BulkMemoryOpt: 0'
    return `const real = ${real}
Bun.plugin({
  name: 'binaryen ${how}',
  setup(build) {
    build.module('binaryen', () => {
      if (!real) throw new Error('Cannot find package "binaryen"')
      const Features = { ...real.Features, ${features} }
      return { exports: { default: Object.create(real, { Features: { value: Features } }) }, loader: 'object' }
    })
  },
})
`
  }

  // When binaryen can't optimize, -O says so and writes the module
  // unoptimized; with --strict-opt, and always with --release, the command
  // exits 1 and writes nothing.
  test('without binaryen, -O falls back, --strict-opt and --release fail', async () => {
    const preload = fakeBinaryen('missing')
    const missing = `binaryen ${binaryenVersion} could not be loaded: Cannot find package "binaryen"`
    const optimize = await wasm(['-O', '--size', '--json'], { preload })
    expect(optimize.exitCode).toBe(0)
    expect(optimize.stderr).toContain(`Warning: ${missing}; writing the unoptimized module (--strict-opt makes this an error)\n`)
    expect(JSON.parse(optimize.stdout)).toMatchObject({ unoptimized: optimize.written?.length, optimized: null })

    for (const flags of [['-O', '--strict-opt'], ['--release']]) {
      const strict = await wasm(flags, { preload })
      expect(strict.exitCode).toBe(1)
      expect(strict.written).toBeNull()
      const flag = flags.at(-1)
      expect(strict.stderr).toBe(`Error: ${missing}\nNothing written: ${flag} does not fall back to the unoptimized module\n`)
    }
  }, 60_000)

  test('--release fails when binaryen refuses the module or throws', async () => {
    const invalid = await wasm(['--release'], { preload: fakeBinaryen('invalid') })
    expect(invalid.exitCode).toBe(1)
    expect(invalid.written).toBeNull()
    expect(invalid.stderr).toContain('Error: the module does not validate in binaryen (its report is above)\n')
    const throws = await wasm(['--release'], { preload: fakeBinaryen('throws') })
    expect(throws.exitCode).toBe(1)
    expect(throws.written).toBeNull()
    expect(throws.stderr).toContain('Error: binaryen failed: Aborted(')
  }, 60_000)
})

// encantis test gives each imported global the zero of its type. A module
// whose start function traps (a plain host global given null, against the
// promise of its type) runs none of its tests, and says why, without
// crashing.
describe('encantis test and imported globals', () => {
  async function runTests(source: string) {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
    try {
      const file = join(dir, 'globals.ents')
      await writeFile(file, source)
      const run = Bun.spawnSync([process.execPath, CLI, 'test', file])
      return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }
    } finally {
      await rm(dir, { recursive: true })
    }
  }

  test('a module that imports globals has its tests run', async () => {
    const { exitCode, stdout } = await runTests('type Canvas = host\nimport "env" (\n  "c" global c: ?Canvas\n  "n" global n: u32\n)\ntest "zeros" {\n  assert c == 0\n  assert n == 0\n}\n')
    expect(stdout).toContain('pass: zeros')
    expect(exitCode).toBe(0)
  })

  // A plain host global is never null: the test host gives it a stand-in,
  // and the module's start check passes.
  test('a module that imports a plain host global has its tests run', async () => {
    const { exitCode, stdout } = await runTests('type Canvas = host\nimport "env" "c" global c: Canvas\nexport func f() -> Canvas => c\nexport func add(a: i32, b: i32) -> i32 => a + b\ntest "adds" {\n  assert add(1, 2) == 3\n}\n')
    expect(stdout).toContain('pass: adds')
    expect(exitCode).toBe(0)
  })

  // Data larger than a memory with a fixed maximum does not fit when the
  // module is instantiated.
  test('a module that does not start fails its tests and says why', async () => {
    const { exitCode, stdout, stderr } = await runTests('memory 1 1\ndata big = [1:u8; 70000]\nexport func f() -> u32 => big.len\ntest "never runs" {\n  assert true\n}\n')
    expect(stderr).toContain('the module did not start')
    expect(stdout).toContain('0 passed, 1 failed')
    expect(exitCode).toBe(1)
  })
})

// `encantis lsp`: the language server on stdin and stdout, as an editor or an
// agent starts it. What the server answers is tested in the lsp package; here,
// that the command serves it: it starts with no file, writes the protocol and
// nothing else on stdout, finds the workspace's files itself, and ends when
// the client says exit.
describe('the language server on the command line', () => {
  interface Message {
    id?: number
    method?: string
    params?: unknown
    result?: unknown
    error?: { message: string }
  }

  // A client of the server: messages framed as the protocol frames them, and
  // what the server writes, in which anything but a frame is kept as stray.
  function client(server: Bun.Subprocess<'pipe', 'pipe', 'pipe'>) {
    let id = 0
    const answers = new Map<number, (message: Message) => void>()
    const notifications: Message[] = []
    let heard = () => {}
    let stray = ''
    const send = (message: Message) => {
      const body = JSON.stringify({ jsonrpc: '2.0', ...message })
      server.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      server.stdin.flush()
    }
    const read = async () => {
      let buffer = Buffer.alloc(0)
      for await (const chunk of server.stdout) {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const end = buffer.indexOf('\r\n\r\n')
          if (end < 0) break
          const length = /^Content-Length: (\d+)$/.exec(buffer.subarray(0, end).toString())
          if (!length) {
            stray += buffer.toString()
            buffer = Buffer.alloc(0)
            break
          }
          const start = end + 4
          if (buffer.length < start + Number(length[1])) break
          const message: Message = JSON.parse(buffer.subarray(start, start + Number(length[1])).toString())
          buffer = buffer.subarray(start + Number(length[1]))
          // A request of the server's (to register a capability) gets an
          // empty answer.
          if (message.method !== undefined && message.id !== undefined) send({ id: message.id, result: null })
          else if (message.method !== undefined) {
            notifications.push(message)
            heard()
          } else if (message.id !== undefined) answers.get(message.id)?.(message)
        }
      }
    }
    read()
    return {
      stray: () => stray,
      notify: (method: string, params: unknown) => send({ method, params }),
      request: <T>(method: string, params: unknown) =>
        new Promise<T>((resolve, reject) => {
          answers.set(++id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result as T)))
          send({ id, method, params })
        }),
      // The first notification of a method that holds
      notification: async <T>(method: string, holds: (params: T) => boolean) => {
        for (;;) {
          const found = notifications.find((m) => m.method === method && holds(m.params as T))
          if (found) return found.params as T
          await new Promise<void>((resolve) => {
            heard = resolve
          })
        }
      },
    }
  }

  test('serves a workspace over stdin and stdout, and exits when told to', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-lsp-'))
    try {
      await writeFile(join(dir, 'util.ents'), 'export func add(a: i32, b: i32) -> i32 => a + b\n')
      // Not a file of the workspace's own
      await mkdir(join(dir, 'node_modules'))
      await writeFile(join(dir, 'node_modules', 'dep.ents'), 'export func dep() -> i32 => 1\n')
      const server = Bun.spawn([process.execPath, CLI, 'lsp'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      const lsp = client(server)
      const root = pathToFileURL(dir).href
      const started = await lsp.request<{ capabilities: { hoverProvider?: boolean; workspaceSymbolProvider?: boolean } }>('initialize', {
        processId: null,
        rootUri: root,
        workspaceFolders: [{ uri: root, name: 'workspace' }],
        capabilities: {},
      })
      expect(started.capabilities.hoverProvider).toBe(true)
      expect(started.capabilities.workspaceSymbolProvider).toBe(true)
      lsp.notify('initialized', {})

      // A document is checked as it is opened
      const main = pathToFileURL(join(dir, 'main.ents')).href
      lsp.notify('textDocument/didOpen', { textDocument: { uri: main, languageId: 'encantis', version: 1, text: 'export func f() -> u32 {\n  return true\n}\n' } })
      const published = await lsp.notification<{ uri: string; diagnostics: { message: string; range: { start: { line: number } } }[] }>(
        'textDocument/publishDiagnostics',
        (params) => params.uri === main,
      )
      expect(published.diagnostics.map((d) => [d.range.start.line, d.message])).toEqual([[1, 'cannot assign bool to u32']])

      // The open document's declarations and those of the files found on
      // disk (by file name: on Windows the server writes the drive as VS
      // Code does, file:///c:/)
      const symbols = await lsp.request<{ name: string; location: { uri: string } }[]>('workspace/symbol', { query: '' })
      expect(symbols.map((s) => [s.name, s.location.uri.split('/').pop()]).sort()).toEqual([
        ['add', 'util.ents'],
        ['f', 'main.ents'],
      ])

      await lsp.request('shutdown', null)
      lsp.notify('exit', null)
      expect(await server.exited).toBe(0)
      expect(lsp.stray()).toBe('')
    } finally {
      await rm(dir, { recursive: true })
    }
  }, 30000)
})

// The Claude Code plugin (plugins/encantis) starts the server as `encantis
// lsp`, for the files the VS Code extension takes as Encantis, under the
// same language id.
test('the Claude Code plugin runs `encantis lsp` for .ents files', () => {
  const root = join(import.meta.dir, '..', '..', '..')
  const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))
  const plugin = read('plugins/encantis/.claude-plugin/plugin.json')
  const servers = Object.values(plugin.lspServers) as { command: string; args: string[]; extensionToLanguage: Record<string, string> }[]
  expect(servers).toHaveLength(1)
  const [server] = servers
  expect(server.command).toBe(Object.keys(read('packages/cli/package.json').bin)[0])
  expect(server.args).toEqual(['lsp'])
  const languages = read('packages/extension/package.json').contributes.languages as { id: string; extensions?: string[] }[]
  const encantis = languages.find((l) => l.extensions?.includes('.ents'))
  expect(encantis).toBeDefined()
  expect(server.extensionToLanguage).toEqual({ '.ents': encantis?.id ?? '' })
  // The marketplace lists it where it is
  const listed = read('.claude-plugin/marketplace.json').plugins.find((p: { name: string }) => p.name === plugin.name)
  expect(listed?.source).toBe('./plugins/encantis')
})
