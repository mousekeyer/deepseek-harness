# Building the DeepSeek Harness RPM

This directory packages `@deepseek-ai/dsh` for RHEL 9 and its rebuilds
(AlmaLinux 9, Rocky Linux 9). The build runs in two phases, because the
JavaScript tree must be compiled with Node.js 24 while a clean EL9 build host
has neither Node.js 24 nor network access inside the build root.

| Phase | Host | What it does | Output |
| --- | --- | --- | --- |
| one | networked x86_64/aarch64 Linux with Node.js 24 + pnpm 11.28.5 | installs, builds, deploys, stages and tars the runtime tree | `deepseek-harness-0.2.2-alpha.2-payload.tar.gz` |
| two | any EL9 host with `rpm-build` (no network needed) | unpacks that tarball and assembles the package | `deepseek-harness-0.2.2~alpha.2-1.el9.x86_64.rpm` |

Phase one is `build-payload.sh` plus `stage-payload.ts`; phase two is
`deepseek-harness.spec`.

## Files

| Path | Role |
| --- | --- |
| `build-payload.sh` | phase-one driver: install, native build, artifact build, staging, tarball |
| `stage-payload.ts` | phases the deployed closure into a symlink-free tree with a pinned Node.js |
| `deepseek-harness.spec` | the package recipe; `Source0` is the phase-one tarball |
| `dsh-web.service` | optional systemd unit for `dsh web` (`--with web_service`) |
| `dsh.sysconfig` | optional `/etc/sysconfig/dsh` for that unit |

## Phase one: build the payload

Requirements on the build host:

- Linux, `x86_64` or `aarch64`, matching the target package architecture.
- Node.js 24.9.0 or newer **with development headers** (`node_api.h` is
  resolved at `$(dirname $(command -v node))/../include/node`; distro packages
  ship it as `nodejs-devel`, the upstream tarball includes it).
- pnpm 11.28.5 (`corepack enable` is enough).
- A C compiler (`gcc` or `clang`) for the native addon.
- Optional: `musl-gcc` for the static-musl `landlock-run` sandbox launcher.
  Without it the payload ships bubblewrap-only confinement; see
  *Sandboxing* below.
- Network access to the pnpm registry, `nodejs.org`, and nothing else.

```sh
packaging/rpm/build-payload.sh
```

Useful options:

| Option | Effect |
| --- | --- |
| `--work <dir>` | scratch directory for the staged tree (default `<repo>/dist-exe/rpm/payload`) |
| `--out <dir>` | where the tarball is written (default `<repo>/dist-exe/rpm`) |
| `--node-from <dir>` | reuse an existing runtime (`bin/node` + `LICENSE`) instead of downloading the pinned one |
| `--skip-node` | omit the runtime entirely; the package then depends on the system `nodejs` |
| `--with-landlock` | fail unless `musl-gcc` is present and `landlock-run` is built |
| `--without-landlock` | skip the full native build and accept a payload without `landlock-run` |

The script performs, in order:

1. `pnpm install --frozen-lockfile`.
2. `pnpm exec tsx native/system/scripts/build.ts` when `musl-gcc` is available.
   This full native build produces `bin/landlock-run` (static musl) and both
   libc variants of the `flock` N-API addon in
   `native/system/packages/linux-<arch>/bin/`. The prebuilt binaries are not
   committed to the repository, so this step is what puts them in the payload.
3. `DSH_CLIENT_TITLE='DeepSeek Harness' pnpm run build:artifacts` — the same
   gate graph the repository's own carriers use: native addons, Typert, host
   compilation and bundling, the desktop bundle, client compilation and
   bundling, then the Vite web build that writes `apps/web/dist`.
4. `pnpm exec tsx packaging/rpm/stage-payload.ts --work <dir>`, which:
   - runs `pnpm --filter @deepseek-ai/dsh deploy --legacy --prod` with
     `node-linker=hoisted`, mirroring `scripts/build-exe-for-python-sdk.ts`,
   - restores the direct dependencies that pnpm's legacy hoister leaves beside
     the deploy source, materializes every deploy-time symlink into real files,
     and removes duplicate hoisted workspace copies,
   - prunes `README*`, `CHANGELOG*`, `HISTORY*`, `*.map` and `*.d.ts` from
     `node_modules` (never from an `assets` directory),
   - asserts that no symbolic link survives,
   - downloads the pinned Node.js from `scripts/primary-runtime/lock.json`
     (24.21.0, SHA-256 verified) unless `--node-from` or `--skip-node` is given,
   - asserts that `@deepseek-ai/dsh-web-frontend/dist/index.html` and the glibc
     N-API addon are present, and warns when `landlock-run` is absent.
5. Tars the tree, then smoke tests it with the bundled runtime:
   `node/bin/node app/lib/bin.js --version`.

The resulting tree is:

```
deepseek-harness-0.2.2-alpha.2-payload/
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── app/                      # @deepseek-ai/dsh plus its hoisted node_modules
│   ├── package.json
│   ├── lib/bin.js            # CLI entry point
│   └── node_modules/
└── node/                     # pinned runtime (omitted with --skip-node)
    ├── LICENSE
    └── bin/node
```

## Phase two: build the RPM

On the EL9 host (or inside `mock`):

```sh
sudo dnf install -y rpm-build rpmdevtools
rpmdev-setuptree

cp dist-exe/rpm/deepseek-harness-0.2.2-alpha.2-payload.tar.gz ~/rpmbuild/SOURCES/
cp packaging/rpm/dsh-web.service packaging/rpm/dsh.sysconfig ~/rpmbuild/SOURCES/

rpmbuild -bb packaging/rpm/deepseek-harness.spec
```

The spec reads only those three sources: no `%build` step compiles anything,
and `%install` copies the staged tree to `/usr/libexec/deepseek-harness`,
writes the `/usr/bin/dsh` wrapper, and installs the license files. Rebuilds of
the same tarball are byte-identical apart from RPM metadata.

**Pin the payload by digest.** `build-payload.sh` prints the tarball's SHA-256
after it writes the file:

```
build-payload: sha256 3f1c...e9a0
```

Paste it into the spec's `%global payload_sha256` (replacing `PENDING`).
`%prep` then refuses to build when Source0 changes under the same filename.
While the placeholder is still `PENDING`, `%prep` warns and continues, so a
first build works before the digest exists.

`%check` is **off by default** and enabled with `--with check`. The upstream
test suite cannot run inside the build root — it needs the development
dependency closure the payload omits — and a failing `%check` aborts the build,
so the remaining assertions are opt-in. When enabled they check that
`dsh --version` prints the upstream version (bundled-runtime builds only), that
the web frontend `index.html` and the platform N-API addon exist, and that
`landlock-run --probe` reports enforcement when that launcher shipped.

With `mock`, build the payload tarball first, then:

```sh
mock -r almalinux-9-x86_64 --resultdir=build/rpm/result \
  --define '_sourcedir /absolute/path/to/rpmbuild/SOURCES' \
  build packaging/rpm/deepseek-harness.spec
```

### Options

| Spec macro | Default | Effect |
| --- | --- | --- |
| `--with bundled_node` / `--without bundled_node` | bundled | ship the pinned runtime (`Provides: bundled(nodejs)`) or depend on `nodejs >= 24.9.0` |
| `--with check` | off | run the smoke assertions in `%check`; off because a failing check aborts the build |
| `--with web_service` | off | install `dsh-web.service`, `/etc/sysconfig/dsh`, the `dsh` service account and `/var/lib/deepseek-harness` |

```sh
rpmbuild -bb --with check packaging/rpm/deepseek-harness.spec
rpmbuild -bb --with web_service packaging/rpm/deepseek-harness.spec
rpmbuild -bb --without bundled_node packaging/rpm/deepseek-harness.spec   # payload built with --skip-node
```

`--without bundled_node` only makes sense with a payload built by
`build-payload.sh --skip-node`; otherwise the runtime is present but unreachable
from the wrapper's fallback path.

## Verification

On a clean AlmaLinux 9 machine:

```sh
# 1. install (unsigned build: no package signature, so skip the check)
sudo dnf install -y --nogpgcheck ./deepseek-harness-0.2.2~alpha.2-1.el9.x86_64.rpm

# 2. the CLI resolves its own runtime and version
dsh --version                 # 0.2.2-alpha.2
rpm -q --provides deepseek-harness | grep -E 'bundled\(nodejs\)'

# 3. a profile boots offline, with no pnpm and no registry access
dsh headless "reply with the single word ok"

# 4. the web frontend serves
dsh web --host 127.0.0.1 --port 3080 --no-open &
curl -fsS http://127.0.0.1:3080/ | head -c 200
kill %1

# 5. the sandbox finds a runner: bubblewrap is the recommended one
sudo dnf install -y bubblewrap
bwrap --version                # the probe in sandbox-local runs exactly this binary
# and, when phase one had musl-gcc, the built-in launcher reports enforcement:
/usr/libexec/deepseek-harness/app/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run --probe

# 6. removal is clean
sudo dnf remove -y deepseek-harness
test ! -e /usr/libexec/deepseek-harness && test ! -e /usr/bin/dsh && echo removed
```

`dsh` writes `~/.dsh` (or `$DSH_HOME`) on first run; the package does not own
that directory and removal leaves it in place. `--with web_service` additionally
owns `/var/lib/deepseek-harness` and the `dsh` user, which `dnf remove` also
leaves behind.

Common failure modes:

- `dsh: broken installation: .../lib/bin.js is missing` — the wrapper found the
  wrong prefix, usually because `/usr/bin/dsh` was copied or symlinked
  elsewhere instead of installed by the package.
- `error: profile "desktop" is managed exclusively by the Electron application`
  — the desktop profile is not part of this package; run `dsh web`,
  `dsh headless`, or a named profile instead.
- Confined shell commands fail with a sandbox error — install `bubblewrap` or
  rebuild the payload with `musl-gcc` so `landlock-run` ships.

## Sandboxing

`packages/sandbox/sandbox-local` probes the Linux chain `['bwrap', 'landlock']`
and fails closed when neither runner is usable, so the package `Recommends`
`bubblewrap`. The default sandbox mode is `read-only`. When phase one had no
`musl-gcc`, `landlock-run` is absent and only bubblewrap can confine commands;
`stage-payload.ts` warns about exactly that rather than silently shipping a
payload that cannot confine anything.

## Upstream synchronisation

The package tracks the upstream repository; it is a packaging layer, not a
fork. Keep that boundary intact:

1. **Never edit `apps/`, `packages/`, `scripts/` or any configuration to make
   the build pass.** Everything here is additive. When a change to the source
   is genuinely required, it belongs upstream.

2. **Release the version in one place.** `apps/cli/package.json`,
   `packages/boot/app-boot/package.json`, `packages/bundle/web-app/package.json`
   and the root manifest carry the same version. The spec repeats it twice:

   ```spec
   %global upstream_version 0.2.2-alpha.2
   Version:        0.2.2~alpha.2
   ```

   Both must move together, and pre-release separators must stay `~` in
   `Version:` so that `0.2.2~alpha.2 < 0.2.2`. `dsh --version` prints the
   upstream string, which is what `%check` compares against
   `%{upstream_version}`.

3. **Pin the runtime deliberately.** `scripts/primary-runtime/lock.json` carries
   `nodeVersion` and the per-target `nodeSha256`. The spec's
   `Provides: bundled(nodejs)` must match `nodeVersion`. A Node.js bump is a
   packaging change: update the lock, rebuild the payload, update the spec.

4. **Re-check the native prebuilds.** `native/system/packages/*/prebuilds.json`
   declares what the payload must contain. If an upstream change adds a binary
   or an architecture, update `ExclusiveArch:` and the `%ifarch` mapping in the
   spec together with `platform_pkg`.

5. **Re-audit the license surface.** `%files` ships `LICENSE` and
   `THIRD_PARTY_NOTICES.md`, and `License:` is `MIT`. If the production closure
   of `@deepseek-ai/dsh` starts pulling a copyleft dependency (the CLI+web
   closure currently excludes `@deepseek-ai/libreoffice-kit`, the only
   MPL-2.0 package in the tree), the notice file and possibly a source offer
   must be updated in the same change.

6. **Follow the gate graph, not a hand-picked subset.** `build-payload.sh`
   calls `pnpm run build:artifacts` because that is the supported artifact
   graph. If upstream renames or splits it, follow the new name rather than
   reassembling the steps here; `scripts/build.ts` is the authority on ordering.

7. **Sync procedure for a new upstream release:**

   ```sh
   git fetch upstream
   git rebase upstream/master                 # packaging/ carries over unchanged
   # bump %global upstream_version and Version: in deepseek-harness.spec
   packaging/rpm/build-payload.sh
   # paste the printed sha256 into %global payload_sha256 (replacing PENDING)
   rpmbuild -bb packaging/rpm/deepseek-harness.spec
   # run the verification block above on a clean AlmaLinux 9 host
   ```

   Add a `%changelog` entry in the same commit, with the version as built
   (`0.2.2~alpha.2-1`). A version bump always invalidates `payload_sha256`, so
   the digest must be refreshed in the same commit — otherwise `%prep` fails
   with `Source0 checksum mismatch`.

8. **Rebase conflicts are a signal.** `packaging/` should never conflict with
   an upstream change; if it does, the packaging layer reached into a file it
   does not own — move the logic back into `build-payload.sh`,
   `stage-payload.ts`, or the spec instead of resolving the conflict by hand.

## Known deviations and limits

- **No build from source inside `%build`.** The payload is a prebuilt
  JavaScript tree. This is a deliberate, alpha-stage trade-off: a clean EL9
  host has no Node.js 24 and `mock` has no network, so a from-source
  `%build` could not run at all. It must be lifted before any distribution
  package review.
- **Unsigned packages.** Nothing here signs the RPM, so local installs need
  `--nogpgcheck` until a signing key is configured.
- **No full test suite, and `%check` is opt-in.** The upstream tests need the
  development closure, which the payload deliberately omits; the smoke
  assertions that remain run only with `--with check` because a failing
  `%check` aborts the build.
- **`payload_sha256` starts as `PENDING`.** Until the first phase-one build
  prints a digest and it is pasted into the spec, `%prep` warns instead of
  verifying Source0. That is a deliberate bootstrap exception, not a permanent
  state.
- **Architectures are separate builds.** The payload embeds one platform's
  native addons and one architecture's Node.js, so `aarch64` must be built on
  an `aarch64` host; there is no cross-compilation path here.
- **`koffi` must stay at the version the lockfile resolves.** Newer releases
  fail to compile with GCC 13, which is what EL9 ships.
- **`dsh plugin` needs pnpm on `PATH`.** It is a `Suggests`, not a `Requires`,
  because profile boot does not use it.
