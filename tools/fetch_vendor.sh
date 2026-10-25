#!/bin/bash
# Fetch the third-party JavaScript the web app uses into web/vendor/.
#
# The copies are committed, so the app runs offline and from static hosting;
# this script only exists to refresh them. Each package is pinned to a version
# and to the npm registry's sha512 integrity for that version's tarball, so a
# changed or tampered download is refused rather than copied in.
#
# To update a package:
#   npm view <name>@<version> dist.integrity
# then change its version and integrity below, run this script, and update
# web/vendor/VENDOR.md. Prefer versions that have been out for a few weeks.
#
# A .d.ts types file is renamed to .d.mts so the type checker pairs it with
# the .mjs module it describes.
#
# Usage: tools/fetch_vendor.sh

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
vendor="$root/web/vendor"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# fetch NAME VERSION INTEGRITY FILE...
#   FILE is a path inside the package tarball; it is copied to
#   web/vendor/NAME/ under its base name, or as SRC:DEST to rename it.
fetch() {
    local name="$1" version="$2" integrity="$3"
    shift 3
    local tgz="$work/$name-$version.tgz"
    echo "$name@$version"
    curl -sSf -o "$tgz" "https://registry.npmjs.org/$name/-/$name-$version.tgz"
    local got="sha512-$(openssl dgst -sha512 -binary "$tgz" | base64 -w0)"
    if [ "$got" != "$integrity" ]; then
        echo "  integrity mismatch: expected $integrity" >&2
        echo "                      got      $got" >&2
        exit 1
    fi
    mkdir -p "$work/$name" "$vendor/$name"
    tar -xzf "$tgz" -C "$work/$name"
    local f
    for f in "$@"; do
        local src="${f%%:*}" dest="${f#*:}"
        [ "$dest" = "$f" ] && dest="$(basename "$f")"
        cp "$work/$name/package/$src" "$vendor/$name/$dest"
        echo "  $src -> $dest"
    done
}

fetch js-yaml 5.4.3 \
    'sha512-yzzNtgczwgoVHNigCyKTXcQJU4Y8t/ikU4UxXW0BvrLfHTGWZhsNcOT2s/a7vn81/4KqVnNmHjaUEPlvWnNwVw==' \
    dist/js-yaml.mjs dist/js-yaml.d.ts:js-yaml.d.mts LICENSE
