// Builds release artifacts into release/:
//
//   encantis-<version>-<platform>.tar.gz (.zip on Windows)  standalone CLI
//   encantis-vscode-<version>.vsix                           VS Code extension
//   SHA256SUMS                                               checksums of the above
//
// Usage: bun scripts/build-release.ts [version] [--only <platform,...>] [--no-vsix]
// The version defaults to the root package.json's. A leading "v" is dropped.

import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const outDir = join(root, 'release')

// bun --compile target for each release platform.
const PLATFORMS: Record<string, string> = {
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-x64': 'bun-darwin-x64-baseline',
  'darwin-arm64': 'bun-darwin-arm64',
  'windows-x64': 'bun-windows-x64-baseline',
}

const argv = process.argv.slice(2)
const flag = (name: string) => {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const [, value] = argv.splice(i, 2)
  return value
}
const only = flag('--only')?.split(',')
const noVsix = argv.includes('--no-vsix')
const positional = argv.filter(a => !a.startsWith('--'))

const rootPkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const version = (positional[0] ?? rootPkg.version).replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`not a semver version: ${version}`)
  process.exit(1)
}

async function run(cmd: string[], cwd = root) {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if ((await proc.exited) !== 0) throw new Error(`failed: ${cmd.join(' ')}`)
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
const artifacts: string[] = []

for (const [platform, target] of Object.entries(PLATFORMS)) {
  if (only && !only.includes(platform)) continue
  const name = `encantis-${version}-${platform}`
  const stage = join(outDir, name)
  const windows = platform.startsWith('windows')
  const exe = join(stage, windows ? 'encantis.exe' : 'encantis')
  await mkdir(stage, { recursive: true })
  console.log(`building ${name}`)
  await run([
    'bun', 'build', '--compile', '--minify', `--target=${target}`,
    `--define`, `ENCANTIS_VERSION=${JSON.stringify(version)}`,
    'packages/cli/src/cli.ts', '--outfile', exe,
  ])
  for (const file of ['README.md', 'LICENSE-MIT', 'LICENSE-APACHE']) await cp(join(root, file), join(stage, file))
  const archive = windows ? `${name}.zip` : `${name}.tar.gz`
  if (windows) await run(['zip', '-qr', archive, name], outDir)
  else await run(['tar', '-czf', archive, name], outDir)
  await rm(stage, { recursive: true })
  artifacts.push(archive)
}

if (!noVsix) {
  // vsce reads the version from the extension's package.json: set it for the
  // build, then put the file back.
  const extDir = join(root, 'packages/extension')
  const pkgPath = join(extDir, 'package.json')
  const original = await readFile(pkgPath, 'utf8')
  const vsix = `encantis-vscode-${version}.vsix`
  try {
    const pkg = JSON.parse(original)
    pkg.version = version
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
    await run(['bun', 'run', 'bundle'], extDir)
    await run(['bunx', 'vsce', 'package', '--no-dependencies', '--out', join(outDir, vsix)], extDir)
  } finally {
    await writeFile(pkgPath, original)
  }
  artifacts.push(vsix)
}

const sums = await Promise.all(artifacts.map(async file => {
  const hash = createHash('sha256').update(await readFile(join(outDir, file))).digest('hex')
  return `${hash}  ${file}`
}))
await writeFile(join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`)
console.log(`\nrelease/ for ${version}:\n${sums.join('\n')}`)
