# RPM spec for DeepSeek Harness (dsh) on RHEL 9 / AlmaLinux 9.
#
# The package payload is a prebuilt JavaScript tree produced ahead of time by
# build-payload.sh on a networked build host (see packaging/rpm/BUILD.md).
# rpmbuild only unpacks Source0 and assembles files, so this spec never needs
# network access, a Node toolchain, or a pnpm store inside the build root.
#
# Upstream version is 0.2.2-alpha.2. RPM forbids '-' in Version, so the
# prerelease separator becomes '~' (supported since rpm 4.10; EL9 ships 4.16),
# which also sorts 0.2.2~alpha.2 before the eventual 0.2.2 final release.
%global upstream_version 0.2.2-alpha.2
%global payload_dir deepseek-harness-%{upstream_version}-payload
%global app_root %{_libexecdir}/deepseek-harness

# SHA-256 of Source0, printed by build-payload.sh right after it writes the
# tarball. Paste that value here so the payload is pinned by content, not by
# filename: a rerun that changes the tree then fails in %prep instead of
# silently shipping something else under the same name.
#
# （待补充：phase one 首次构建后由 build-payload.sh 打印的 sha256）
# While the placeholder is unchanged, %prep skips the check and prints a
# warning, so an unpackaged source tree still builds.
%global payload_sha256 PENDING

# Bundled Node.js is the default because AlmaLinux 9 AppStream tops out at
# nodejs 22 while this tree requires Node >= 24.9.0, and apps/cli/src/bin.ts
# relies on `import.meta.main` (Node 24+): on Node 22 the CLI would silently
# do nothing. `--without bundled_node` trades that for a nodejs dependency.
%bcond_without bundled_node

# %check is OFF by default, matching the packaging rules for this tree: the
# upstream test suite needs the development dependency closure that the payload
# deliberately omits, and any check that fails aborts the build. Enable it with
# `--with check` to run the smoke assertions below (see BUILD.md).
%bcond_with check

# The HTTP frontend is usable through `dsh web` without a unit; installing one
# is opt-in because it needs a service account, a state directory and a
# sysconfig file that no CLI-only install should create.
%bcond_with web_service

%ifarch x86_64
%global platform_pkg node-addon-system-linux-x64
%endif
%ifarch aarch64
%global platform_pkg node-addon-system-linux-arm64
%endif

Name:           deepseek-harness
Version:        0.2.2~alpha.2
Release:        1%{?dist}
Summary:        DeepSeek Harness agent runtime and command line interface
License:        MIT
URL:            https://github.com/deepseek-ai/deepseek-harness
Source0:        %{payload_dir}.tar.gz
Source1:        dsh-web.service
Source2:        dsh.sysconfig

ExclusiveArch:  x86_64 aarch64

# The payload contains no sources to compile, so there is nothing to debug and
# nothing to link a build id against.
%global debug_package %{nil}
%global _build_id_links none

# Dependencies are left to rpm's ELF scanner: it derives the glibc, libstdc++
# and libgcc requirements of the bundled runtime and of the N-API addons from
# the binaries themselves, which is more accurate than a hand-written list.
%if %{with bundled_node}
# The runtime is shipped, not linked; record it for CVE tracking tooling.
Provides:       bundled(nodejs) = 24.21.0
%else
Requires:       nodejs >= 24.9.0
%endif

# packages/sandbox/sandbox-local probes a candidate chain ['bwrap', 'landlock']
# on Linux and fails closed when none is usable, so a working bubblewrap turns
# confined shell commands on without any configuration.
Recommends:     bubblewrap
# Only `dsh plugin` shells out to pnpm to add or remove profile plugins, and it
# only needs it when the user installs one; profile launch resolves every
# bundle from the install anchor instead.
Suggests:       pnpm

%if %{with web_service}
BuildRequires:  systemd-rpm-macros
Requires(pre):  shadow-utils
Requires(post): systemd
Requires(preun): systemd
Requires(postun): systemd
%endif

%description
DeepSeek Harness is an agent runtime: a Cordis-based plugin host that boots a
profile from the bundles installed beside it and exposes that profile through
several frontends, including an interactive terminal UI, a headless one-shot
runner, and a local web application.

This package installs the @deepseek-ai/dsh command line interface together
with its full production dependency closure, the web frontend assets, the
platform-specific native addons, and (by default) a pinned Node.js runtime at
a private path, so that no system-wide Node.js installation is required.

Disabling the bundled runtime with `--without bundled_node` makes the package
depend on nodejs >= 24.9.0 instead.

%if %{with web_service}
This build also installs an optional systemd unit that serves the web
frontend on 127.0.0.1:3080, and enables it at boot.
%endif

%prep
# Pin the payload by content. `payload_sha256` is what build-payload.sh printed
# when it wrote the tarball, so a rerun that changes the tree fails here instead
# of quietly shipping different bits under the same filename.
if [ '%{payload_sha256}' = PENDING ]; then
  echo 'deepseek-harness: payload_sha256 is not pinned; skipping the Source0 checksum' >&2
  echo 'deepseek-harness: paste the digest printed by packaging/rpm/build-payload.sh into the spec' >&2
else
  actual=$(sha256sum %{_sourcedir}/%{payload_dir}.tar.gz | cut -d' ' -f1)
  if [ "$actual" != '%{payload_sha256}' ]; then
    echo "deepseek-harness: Source0 checksum mismatch: expected %{payload_sha256}, got $actual" >&2
    exit 1
  fi
fi
%setup -q -n %{payload_dir}

%build
# Nothing is compiled here. The JavaScript bundles, the web assets and the
# native addons all arrive already built inside Source0; see BUILD.md for the
# phase-one build that produces it. Refusing to pretend otherwise keeps the
# deviation from "build from source" visible instead of hidden in %install.
test -f app/package.json
test -f app/lib/bin.js

%install
install -d %{buildroot}%{app_root}/app
cp -a app/. %{buildroot}%{app_root}/app/

%if %{with bundled_node}
install -d %{buildroot}%{app_root}/node/bin
install -m 0755 node/bin/node %{buildroot}%{app_root}/node/bin/node
install -m 0644 node/LICENSE %{buildroot}%{app_root}/node/LICENSE
%endif

install -d %{buildroot}%{_bindir}
# The wrapper resolves its own install prefix and then execs an explicit node
# against the prebuilt entry point. It is not a symlink: the deployed
# entry point keeps its shebang but not necessarily an executable bit, and a
# relative resolution keeps the wrapper working inside a build root.
cat > %{buildroot}%{_bindir}/dsh <<'DSH_WRAPPER'
#!/bin/sh
# DeepSeek Harness entry point. Resolves the install prefix from its own path
# so the same wrapper works from a build root and from /usr.
set -eu
bindir=$(dirname -- "$(readlink -f -- "$0")")
root=$bindir/../libexec/deepseek-harness
if [ ! -f "$root/app/lib/bin.js" ]; then
  echo "dsh: broken installation: $root/app/lib/bin.js is missing" >&2
  exit 127
fi
if [ -x "$root/node/bin/node" ]; then
  node=$root/node/bin/node
else
  node=${DSH_NODE:-node}
fi
exec "$node" "$root/app/lib/bin.js" "$@"
DSH_WRAPPER
chmod 0755 %{buildroot}%{_bindir}/dsh

%if %{with web_service}
install -d %{buildroot}%{_unitdir}
install -m 0644 %{SOURCE1} %{buildroot}%{_unitdir}/dsh-web.service
install -d %{buildroot}%{_sysconfdir}/sysconfig
install -m 0644 %{SOURCE2} %{buildroot}%{_sysconfdir}/sysconfig/dsh
install -d -m 0750 %{buildroot}%{_localstatedir}/lib/deepseek-harness
%endif

%check
# DISABLED BY DEFAULT, ON PURPOSE (rules for this tree: %check is opt-in).
#
# The upstream test suite is not runnable here: it needs the development
# dependency closure, which the payload deliberately omits, so `pnpm test`
# cannot execute inside the build root. What remains below are smoke
# assertions over the assembled tree. They are still gated behind
# `--with check` because a failing %check aborts the build, and the two
# conditions they depend on are environment facts rather than packaging facts:
#
#   * the wrapper can only run when a runtime exists inside the build root,
#     i.e. only in the bundled_node variant;
#   * `landlock-run` only exists when phase one had musl-gcc, so its probe is
#     conditional by design.
#
# Enable with:  rpmbuild -bb --with check packaging/rpm/deepseek-harness.spec
%if %{with check}
%if %{with bundled_node}
%{buildroot}%{_bindir}/dsh --version | grep -Fx -- '%{upstream_version}'
%endif
test -r %{buildroot}%{app_root}/app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html
test -f %{buildroot}%{app_root}/app/node_modules/@deepseek-ai/%{platform_pkg}/bin/glibc/system.node
launcher=%{buildroot}%{app_root}/app/node_modules/@deepseek-ai/%{platform_pkg}/bin/landlock-run
if [ -x "$launcher" ]; then
  "$launcher" --probe
fi
%endif

# The scriptlets exist only for the optional unit; without it the package has
# no service account, no state directory and no systemd interaction.
%if %{with web_service}
%pre
getent group dsh >/dev/null || groupadd -r dsh
getent passwd dsh >/dev/null || useradd -r -g dsh -d %{_localstatedir}/lib/deepseek-harness \
  -s /sbin/nologin -c 'DeepSeek Harness service account' dsh
exit 0

%post
%systemd_post dsh-web.service

# The process runs as `dsh` but keeps its profile state under DSH_HOME.
chown -R dsh:dsh %{_localstatedir}/lib/deepseek-harness || :

%preun
%systemd_preun dsh-web.service

%postun
%systemd_postun_with_restart dsh-web.service
%endif

%files
%dir %{app_root}
%{app_root}/app
%if %{with bundled_node}
%{app_root}/node
%endif
%{_bindir}/dsh
%license LICENSE
%doc THIRD_PARTY_NOTICES.md
%if %{with web_service}
%{_unitdir}/dsh-web.service
%config(noreplace) %{_sysconfdir}/sysconfig/dsh
%attr(0750,dsh,dsh) %dir %{_localstatedir}/lib/deepseek-harness
%endif

# Replace the placeholder maintainer identity below with a real address before
# submitting this package to any repository that records a packager.
%changelog
* Mon Nov 02 2026 DeepSeek Harness Packaging <packaging@localhost> - 0.2.2~alpha.2-1
- Initial RPM packaging of DeepSeek Harness for RHEL 9 / AlmaLinux 9.
- Ship the production closure of @deepseek-ai/dsh with a pinned Node.js runtime.
