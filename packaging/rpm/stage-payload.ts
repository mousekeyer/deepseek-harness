/**
 * Phase two of the RPM payload build: turn a built workspace into a
 * self-contained, symlink-free application tree plus a pinned Node runtime.
 *
 * Run through tsx from the repository root, after `pnpm run build:artifacts`:
 *
 *     pnpm exec tsx packaging/rpm/stage-payload.ts
 *
 * The produced directory is `<work>/deepseek-harness-<version>-payload/`, which
 * defaults to `dist-exe/rpm/payload` (already covered by .gitignore) and is
 * what build-payload.sh tars into the spec's Source0.
 *
 * The deploy and fix-up sequence mirrors scripts/build-exe-for-python-sdk.ts so
 * that the packaged closure is assembled exactly like the other shipped
 * carriers: pnpm's legacy deploy, then legacy hoist restoration, then link
 * materialization, then workspace duplicate removal.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import { deduplicateStagedWorkspacePackages, materializeStagedLinks } from '../../scripts/build-exe-for-python-sdk-staging.ts'
import { pnpmInvocation, restoreLegacyHoists } from '../../scripts/executable-packaging.ts'
import { downloadNodeRuntime } from '../../scripts/primary-runtime/prepare.ts'

const DEPLOY_ROOT_PACKAGE = '@deepseek-ai/dsh'

/** Directories whose contents stay even though they look like prunable docs. */
const PRUNE_EXEMPT = [`${sep}assets${sep}`]

/** Documentation and development artifacts that no runtime path reads. */
function prunable(name: string): boolean {
  if (/^README.*\.md$/u.test(name) || /^CHANGELOG.*\.md$/u.test(name) || /^HISTORY.*\.md$/u.test(name)) return true
  return /\.map$/u.test(name) || /\.d\.ts$/u.test(name) || /\.d\.mts$/u.test(name) || /\.d\.cts$/u.test(name)
}

/** Delete prunable files below a package tree, leaving assets and binaries alone. */
function prune(directory: string, removed: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (PRUNE_EXEMPT.some(exempt => path.includes(exempt))) continue
    if (entry.isDirectory()) prune(path, removed)
    else if (prunable(entry.name)) {
      rmSync(path, { force: true })
      removed.push(path)
    }
  }
}

/**
 * Delete directories left with no entries below a package tree.
 *
 * Pruning declarations empties the `lib/types` and `typings` trees, and several
 * upstream packages ship such directories empty in the first place. An installed
 * payload is read-only, so nothing writes into them at runtime, and every one of
 * them costs an entry in the RPM file manifest that names no content.
 */
function removeEmptyDirectories(directory: string, removed: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(directory, entry.name)
    if (PRUNE_EXEMPT.some(exempt => path.includes(exempt))) continue
    removeEmptyDirectories(path, removed)
    if (readdirSync(path).length === 0) {
      rmdirSync(path)
      removed.push(path)
    }
  }
}

/** Return every symbolic link below a directory, so a packaged tree can be proven link-free. */
function symlinksBelow(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) found.push(path)
    else if (metadata.isDirectory()) symlinksBelow(path, found)
  }
  return found
}

/**
 * Give the tree the permissions a system package needs.
 *
 * The checkout is built under whatever umask the build host uses (a restrictive
 * 0077 turns every produced file into 0600), and the package installs the tree
 * as root:root. Files nobody else can read would make the installed CLI unusable
 * for every non-root account, so the executable bit is derived from the owner
 * bit and everything else is normalised to 0644/0755.
 */
function normalizePermissions(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      chmodSync(path, 0o755)
      normalizePermissions(path)
    } else if (!entry.isSymbolicLink()) {
      const executable = (lstatSync(path).mode & 0o100) !== 0
      chmodSync(path, executable ? 0o755 : 0o644)
    }
  }
}

function fail(message: string): never {
  throw new Error(`stage-payload: ${message}`)
}

/** Every installed package directory of a staged `node_modules`, including scopes. */
function installedPackages(modules: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name === '.bin' || entry.name === '.pnpm') continue
    const path = join(modules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(path, { withFileTypes: true })) {
        if (scoped.isDirectory()) found.push(join(path, scoped.name))
      }
      continue
    }
    found.push(path)
  }
  return found
}

/**
 * Report every dependency a staged package declares without a resolvable copy.
 *
 * The deploy uses `link-workspace-packages` with workspace hoisting disabled, so
 * it only roots the deploy target's *direct* dependencies: a transitive
 * workspace package (for example @deepseek-ai/cosmokit, reached through
 * @deepseek-ai/cordis) is declared but never staged. Node resolves such an
 * import from the consuming package upwards, so a payload that misses one starts
 * with ERR_MODULE_NOT_FOUND — and nothing else in the pipeline notices, because
 * `node` finds a copy on any machine that also has the checkout installed.
 *
 * Peer dependencies are checked too: pnpm records them as declarations, and a
 * peer that only the workspace root installs is exactly as absent from the
 * payload as a plain dependency would be.
 *
 * @param app - staged application root whose `node_modules` holds the closure.
 * @returns dependency name to the staged packages that declare it.
 */
function missingDependencies(app: string): Map<string, string[]> {
  const modules = join(app, 'node_modules')
  const missing = new Map<string, string[]>()
  for (const directory of installedPackages(modules)) {
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }
    const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name)
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(name => !optionalPeers.includes(name)),
    ]
    for (const name of declared) {
      const candidates = [
        join(modules, name),
        join(directory, 'node_modules', name),
        join(dirname(directory), 'node_modules', name),
      ]
      if (candidates.some(candidate => existsSync(candidate))) continue
      const dependents = missing.get(name) ?? []
      dependents.push(relative(app, directory))
      missing.set(name, dependents)
    }
  }
  return missing
}

/** Map every workspace package name to its directory, following pnpm-workspace.yaml. */
function workspacePackages(root: string): Map<string, string> {
  const manifest = load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')) as { packages?: string[] }
  const packages = new Map<string, string>()
  for (const pattern of manifest.packages ?? []) {
    let directories = [root]
    for (const segment of pattern.split('/')) {
      const next: string[] = []
      for (const directory of directories) {
        if (segment !== '*') {
          next.push(join(directory, segment))
          continue
        }
        if (!existsSync(directory)) continue
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isDirectory()) next.push(join(directory, entry.name))
        }
      }
      directories = next
    }
    // An entry that is not itself a package (a container of packages) is
    // skipped by the manifest check below.
    for (const directory of directories) {
      const manifestPath = join(directory, 'package.json')
      if (!existsSync(manifestPath)) continue
      const { name } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name: string }
      packages.set(name, directory)
    }
  }
  return packages
}

/**
 * Fill in transitive workspace dependencies the deploy left out.
 *
 * Only workspace packages are restored: their sources are in the checkout and
 * their published form is what the workspace link would have resolved to. A
 * third-party name that is missing means the deploy itself is wrong and the
 * build stops, because guessing a version here would ship an unverified tree.
 */
function completeClosure(app: string, root: string): string[] {
  const packages = workspacePackages(root)
  const restored: string[] = []
  for (const [name, dependents] of missingDependencies(app)) {
    const source = packages.get(name)
    if (source === undefined) {
      fail(`${name} is declared by ${dependents.join(', ')} but absent from the closure and from the workspace`)
    }
    const destination = join(app, 'node_modules', name)
    const nestedNodeModules = join(source, 'node_modules')
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(name)
  }
  const remaining = missingDependencies(app)
  if (remaining.size > 0) fail(`the closure is still incomplete: ${[...remaining.keys()].join(', ')}`)
  return restored
}

const { values } = parseArgs({
  options: {
    work: { type: 'string' },
    'node-from': { type: 'string' },
    cache: { type: 'string' },
    'skip-node': { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

const root = resolve(import.meta.dirname, '..', '..')
// build-payload.sh always passes --work; the default keeps a standalone run
// inside the ignored scratch tree instead of dirtying the checkout.
const work = resolve(root, values.work ?? join('dist-exe', 'rpm', 'payload'))
const { version } = JSON.parse(readFileSync(join(root, 'apps', 'cli', 'package.json'), 'utf8')) as { version: string }
const payload = join(work, `deepseek-harness-${version}-payload`)
const app = join(payload, 'app')
const nodeDestination = join(payload, 'node')

// A stale tree would silently ship files that no longer exist upstream.
if (!resolve(payload).startsWith(resolve(root) + sep)) fail(`refusing to write outside the repository: ${payload}`)
if (resolve(payload) === resolve(root)) fail(`refusing to clear the repository root: ${payload}`)
rmSync(payload, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

console.log(`stage-payload: deploying ${DEPLOY_ROOT_PACKAGE}@${version} into ${relative(root, app)}`)
// The deploy flags are the ones the other shipped carriers use: the legacy
// deploy keeps workspace packages as real directories, hoisted resolution
// produces one flat node_modules, and workspace linking is left to pnpm's
// workspace mechanism rather than a registry lookup.
const [deployCommand, deployArgs] = pnpmInvocation([
  '--filter', DEPLOY_ROOT_PACKAGE,
  'deploy', '--legacy', '--prod',
  '--config.allow-unused-patches=true',
  '--config.node-linker=hoisted',
  '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true',
  '--config.hoist-workspace-packages=false',
  app,
])
try {
  execFileSync(deployCommand, deployArgs, { cwd: root, stdio: 'inherit' })
} finally {
  // A legacy deploy records production-only workspace state, which leaves the
  // checkout unable to build again; restore the development installation.
  const [installCommand, installArgs] = pnpmInvocation([
    'install', '--offline', '--frozen-lockfile', '--prod=false', '--ignore-scripts',
  ])
  execFileSync(installCommand, installArgs, { cwd: root, stdio: 'inherit' })
}

if (!existsSync(join(app, 'package.json'))) fail(`deploy produced no package.json at ${app}`)
if (!existsSync(join(app, 'lib', 'bin.js'))) fail(`deploy produced no entry point at ${app}/lib/bin.js`)

// apps/cli/node_modules is the installation the deploy was resolved from, so it
// is also the only complete source for direct dependencies the legacy hoister
// leaves out of the target.
const sourceNodeModules = [
  join(root, 'apps', 'cli', 'node_modules'),
  join(root, 'node_modules'),
].find(existsSync)
if (sourceNodeModules === undefined) fail('no installed node_modules found; run pnpm install first')
const restored = await restoreLegacyHoists(app, sourceNodeModules)
if (restored.length > 0) console.log(`stage-payload: restored ${String(restored.length)} hoisted dependencies`)

await materializeStagedLinks(app)
await deduplicateStagedWorkspacePackages(app, root)

// The deploy roots only the deploy target's direct dependencies, so a
// transitive workspace package can be declared and never staged. Nothing
// downstream catches that: the packed tree starts with ERR_MODULE_NOT_FOUND,
// while any host that also has the checkout installed resolves the import from
// its own node_modules and reports success.
const completed = completeClosure(app, root)
if (completed.length > 0) {
  console.log(`stage-payload: completed the closure with ${String(completed.length)} workspace packages: ${completed.join(', ')}`)
}

const removed: string[] = []
prune(join(app, 'node_modules'), removed)
const emptied: string[] = []
removeEmptyDirectories(join(app, 'node_modules'), emptied)
// The deploy target carries the project's own docs; the spec ships the
// repository copies instead.
for (const name of ['README.md', 'README.zh.md', 'README.i18n.yaml']) rmSync(join(app, name), { force: true })
console.log(`stage-payload: pruned ${String(removed.length)} documentation and declaration files and ${String(emptied.length)} emptied directories`)

const links = symlinksBelow(app)
if (links.length > 0) fail(`staged payload still contains ${String(links.length)} symbolic links, first: ${links[0]}`)

if (!values['skip-node']) {
  mkdirSync(nodeDestination, { recursive: true })
  if (values['node-from'] !== undefined) {
    const source = resolve(values['node-from'])
    if (!existsSync(join(source, 'bin', 'node'))) fail(`--node-from ${source} has no bin/node`)
    copyFileSync(join(source, 'bin', 'node'), join(nodeDestination, 'bin', 'node'))
    copyFileSync(join(source, 'LICENSE'), join(nodeDestination, 'LICENSE'))
  } else {
    // The target key, the archive URL and the SHA-256 all come from
    // scripts/primary-runtime/lock.json, so the vendored runtime is the same
    // pinned Node the other carriers ship.
    const target = `linux-${process.arch}`
    if (target !== 'linux-x64' && target !== 'linux-arm64') fail(`no locked Node runtime for linux-${process.arch}`)
    await downloadNodeRuntime(target, nodeDestination, resolve(values.cache ?? join(work, 'cache')))
  }
  process.stdout.write(`stage-payload: pinned Node ${execFileSync(join(nodeDestination, 'bin', 'node'), ['--version']).toString().trim()}\n`)
}

for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  const source = join(root, name)
  if (!existsSync(source)) fail(`missing ${name} at the repository root`)
  copyFileSync(source, join(payload, name))
}

// A restrictive host umask would otherwise ship 0600 files inside a root:root
// package, which no non-root account could read.
chmodSync(payload, 0o755)
normalizePermissions(payload)
console.log('stage-payload: normalized permissions to 0755 directories and 0644/0755 files')

// The checks the spec repeats are asserted here first, while the failure still
// names the phase that broke.
const webIndex = join(app, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
if (!existsSync(webIndex)) fail(`web frontend assets are missing from the closure: ${webIndex}`)
const platform = join(app, 'node_modules', '@deepseek-ai', `node-addon-system-linux-${process.arch}`)
if (!existsSync(join(platform, 'bin', 'glibc', 'system.node'))) {
  fail(`the glibc N-API addon is missing from the closure: ${platform}/bin/glibc/system.node`)
}
if (!existsSync(join(platform, 'bin', 'landlock-run'))) {
  console.warn('stage-payload: landlock-run is absent; confined commands will fall back to bubblewrap or fail closed.')
}

console.log(`stage-payload: payload ready at ${relative(root, payload)}`)
