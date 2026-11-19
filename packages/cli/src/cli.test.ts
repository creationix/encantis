// What the command line itself adds to a check error: where it is printed,
// and the calls an error inside an instance of a generic was required from.
// What the checker reports is tested in the compiler package.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
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

// `wasm -O` optimizes with binaryen in this process, the version
// package.json pins (wasm.ts). The program returns a struct of three u64 as
// three values, and fills memory with memory.fill (bulk memory).
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

  // `encantis wasm <file> -o <dir>/out.wasm [flags]` on PROGRAM; `preload`
  // is a script bun runs before the command.
  async function wasm(flags: string[], { preload = '' } = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'encantis-cli-'))
    try {
      const file = join(dir, 'program.ents')
      await writeFile(file, PROGRAM)
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

  // --version names the binaryen it optimizes with: two builds are of the
  // same tools when their versions say the same.
  test('--version names binaryen', () => {
    const run = Bun.spawnSync([process.execPath, CLI, '--version'])
    expect(run.stdout.toString()).toBe(`encantis dev (binaryen ${binaryenVersion})\n`)
  })

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
  // unoptimized.
  test('without binaryen, -O writes the module unoptimized', async () => {
    const optimize = await wasm(['-O'], { preload: fakeBinaryen('missing') })
    expect(optimize.exitCode).toBe(0)
    expect(optimize.written?.length).toBeGreaterThan(0)
    expect(optimize.stderr).toContain(
      `Warning: binaryen ${binaryenVersion} could not be loaded: Cannot find package "binaryen"; writing the unoptimized module\n`,
    )
  }, 60_000)

  test('-O falls back when binaryen refuses the module or throws', async () => {
    const invalid = await wasm(['-O'], { preload: fakeBinaryen('invalid') })
    expect(invalid.exitCode).toBe(0)
    expect(invalid.stderr).toContain('Warning: the module does not validate in binaryen (its report is above); writing the unoptimized module\n')
    const throws = await wasm(['-O'], { preload: fakeBinaryen('throws') })
    expect(throws.exitCode).toBe(0)
    expect(throws.stderr).toContain('Warning: binaryen failed: Aborted(')
  }, 60_000)
})
