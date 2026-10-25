# Vendored third-party code

Copies of the external JavaScript the web app uses. They are committed so the
app runs offline and from static hosting. `tools/fetch_vendor.sh` refreshes
them; it pins each package to a version and checks the npm registry's sha512
integrity before copying anything.

| Package | Version | License | Files | Source | Used for |
|---|---|---|---|---|---|
| js-yaml | 5.4.3 | MIT (`js-yaml/LICENSE`) | `js-yaml.mjs`, `js-yaml.d.mts` (types, for the checker only) | https://github.com/nodeca/js-yaml, npm `js-yaml` | YAML import and export |

Dev-only tools (the TypeScript checker, Node's type definitions) are not
vendored. They live in `node_modules/` via the root `package.json` and are
never served.
