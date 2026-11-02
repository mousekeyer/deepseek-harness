#!/usr/bin/env bash
#
# Phase one of the RPM build: turn this checkout into the prebuilt payload
# tarball that the spec consumes as Source0.
#
# Run this on a networked x86_64 (or aarch64) Linux host that has Node.js 24
# with development headers, pnpm 11.28.5, a C compiler, and optionally
# musl-gcc. The result is a single tarball; phase two (`rpmbuild`) then needs
# no network, no Node.js and no pnpm.
#
#   packaging/rpm/build-payload.sh
#
# Scratch space and the tarball stay under dist-exe/rpm/, which .gitignore
# already covers, so a build never leaves untracked files in the checkout.
#
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)

work=$repo_root/dist-exe/rpm/payload
out=$repo_root/dist-exe/rpm
node_from=
skip_node=0
landlock=auto

usage() {
  cat <<'USAGE'
usage: build-payload.sh [--work <dir>] [--out <dir>] [--node-from <dir>]
                        [--skip-node] [--with-landlock | --without-landlock]

  --work <dir>       scratch directory for the payload tree
                     (default: <repo>/dist-exe/rpm/payload)
  --out <dir>        directory that receives the payload tarball
                     (default: <repo>/dist-exe/rpm)
  --node-from <dir>  copy an existing Node runtime (bin/node plus LICENSE)
                     instead of downloading the pinned version
  --skip-node        build the payload without any Node runtime, for a build
                     that depends on the system nodejs package
  --with-landlock    require the static-musl landlock-run launcher
  --without-landlock accept a payload without landlock-run (the default is to
                     build it when musl-gcc is available and warn otherwise)
USAGE
}

fail() {
  echo "build-payload: $*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --work) [ $# -ge 2 ] || fail "--work needs a value"; work=$2; shift 2 ;;
    --out) [ $# -ge 2 ] || fail "--out needs a value"; out=$2; shift 2 ;;
    --node-from) [ $# -ge 2 ] || fail "--node-from needs a value"; node_from=$2; shift 2 ;;
    --skip-node) skip_node=1; shift ;;
    --with-landlock) landlock=yes; shift ;;
    --without-landlock) landlock=no; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument $1" ;;
  esac
done

[ -n "$out" ] || out=$work
mkdir -p -- "$work" "$out"
work=$(cd -- "$work" && pwd)
out=$(cd -- "$out" && pwd)

cd -- "$repo_root"

# The RPM payload is arch-specific: it carries the platform native addon and a
# pinned runtime for one architecture.
case $(uname -m) in
  x86_64) ;;
  aarch64) ;;
  *) fail "payloads are built for x86_64 or aarch64 only, this host is $(uname -m)" ;;
esac
[ "$(uname -s)" = Linux ] || fail "the payload must be built on Linux, this host is $(uname -s)"

# apps/cli/src/bin.ts relies on import.meta.main, and the workspace requires
# Node.js 24.9.0 or newer; a distro Node 22 would build but never run.
command -v node >/dev/null 2>&1 || fail "node is not on PATH; install Node.js 24 first"
node_version=$(node -p 'process.versions.node')
node_major=${node_version%%.*}
[ "$node_major" -ge 24 ] || fail "Node.js 24 or newer is required, found $node_version"
[ -f "$(dirname -- "$(command -v node)")/../include/node/node_api.h" ] \
  || fail "the build Node.js has no development headers at $(dirname -- "$(command -v node)")/../include/node"

command -v pnpm >/dev/null 2>&1 || fail "pnpm is not on PATH; install pnpm 11.28.5 first"
echo "build-payload: node $node_version, pnpm $(pnpm --version)"

# The landlock launcher is a static musl binary, so the optional libc toolchain
# decides whether the payload can confine commands through Landlock at all.
if [ "$landlock" != no ] && ! command -v musl-gcc >/dev/null 2>&1; then
  [ "$landlock" = yes ] && fail "--with-landlock was requested but musl-gcc is not installed"
  echo "build-payload: musl-gcc is missing; landlock-run will not ship and confined commands fall back to bubblewrap"
  landlock=no
fi

echo "build-payload: installing the workspace"
pnpm install --frozen-lockfile

# A full native build produces landlock-run plus both libc variants of the
# flock addon. It needs musl-gcc; the glibc addon alone comes from the
# --host-addon-only gate that build:artifacts runs below either way.
if [ "$landlock" = yes ]; then
  echo "build-payload: building the native addons and the landlock launcher"
  pnpm exec tsx native/system/scripts/build.ts
fi

# build:artifacts runs the supported gate graph: native addons, Typert, host
# compilation and bundling, the desktop bundle, client compilation and
# bundling, then the web build. Skipping the client and web gates would produce
# a payload whose `dsh web` serves nothing.
echo "build-payload: building artifacts"
DSH_CLIENT_TITLE='DeepSeek Harness' pnpm run build:artifacts

echo "build-payload: staging the payload"
stage_args=(--work "$work")
[ -n "$node_from" ] && stage_args+=(--node-from "$node_from")
[ "$skip_node" = 1 ] && stage_args+=(--skip-node)
pnpm exec tsx packaging/rpm/stage-payload.ts "${stage_args[@]}"

version=$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('apps/cli/package.json', 'utf8')).version)")
payload=deepseek-harness-"$version"-payload
[ -d "$work/$payload" ] || fail "the staged payload $work/$payload is missing"

echo "build-payload: packing $payload"
tar --create --gzip --file "$out/$payload.tar.gz" --directory "$work" "$payload"

payload_sha256=$(sha256sum -- "$out/$payload.tar.gz" | cut -d' ' -f1)

if [ "$skip_node" = 0 ]; then
  echo "build-payload: smoke testing the payload entry point"
  "$work/$payload/node/bin/node" "$work/$payload/app/lib/bin.js" --version
fi

cat <<EOF

build-payload: wrote $out/$payload.tar.gz
build-payload: sha256 $payload_sha256

Pin that digest by setting %global payload_sha256 in
packaging/rpm/deepseek-harness.spec; until then %prep only warns.

Phase two copies that tarball into an rpmbuild tree:

  rpmbuild -bb --define '_topdir $out/rpmbuild' packaging/rpm/deepseek-harness.spec

with the tarball, packaging/rpm/dsh-web.service and packaging/rpm/dsh.sysconfig
in \$rpmbuild/SOURCES/; see packaging/rpm/BUILD.md.
EOF
