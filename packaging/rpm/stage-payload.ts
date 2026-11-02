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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
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

function fail(message: string): never {
  throw new Error(`stage-payload: ${message}`)
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

const removed: string[] = []
prune(join(app, 'node_modules'), removed)
// The deploy target carries the project's own docs; the spec ships the
// repository copies instead.
for (const name of ['README.md', 'README.zh.md', 'README.i18n.yaml']) rmSync(join(app, name), { force: true })
console.log(`stage-payload: pruned ${String(removed.length)} documentation and declaration files`)

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
