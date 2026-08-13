# Configuration

`copse.config.json` is optional until repository wiring is installed. Unknown
keys and every invalid value are reported together.

| key | default | contract |
| --- | --- | --- |
| `baseBranch` | `"main"` | non-empty branch name |
| `releaseBranch` | `null` | optional second protected branch |
| `branchPrefixes` | `feat`, `fix`, `docs`, `chore` | non-empty lowercase alphanumeric prefixes; no hyphens |
| `carryFiles` | `[]` | safe repository-relative file paths |
| `carryDirs` | `[]` | safe repository-relative directory paths; no overlap with files |
| `install` | `null` | null or one non-empty argv array |
| `verify` | `[]` | array of non-empty argv arrays |
| `agents` | Codex and Claude defaults | map of lowercase names to argv arrays |
| `coordinationFile` | `.copse/features.json` | safe relative seed/documentation path |
| `runner` | `npx --yes copse` | argv prefix used by generated forwards |

Command values are arrays so elements are passed directly to child processes
and cannot become shell operators. Absolute paths, `..`, and backslashes are
refused for carried and coordination paths. Carried leaf and intermediate
symlinks are checked again at copy time; `carryDirs` trees are also walked and
refuse every nested symlink before copying or rescue begins.

## Branch and directory mapping

A feature branch has exactly one slash and the shape
`<prefix>/<lower-kebab>`. Its worktree is a flat sibling of the main checkout:

```text
/workspace/project                 main worktree
/workspace/project-feat-inbox      feat/inbox
/workspace/project-fix-null-check  fix/null-check
```

Keeping the prefix makes branch-to-directory conversion reversible and avoids
`feat/foo` colliding with `fix/foo`.

## Runner choices

After npm publication the default requires no project dependency. Before that,
use the GitHub source:

```json
{ "runner": ["npx", "--yes", "github:AaronLPS/copse"] }
```

copse itself dogfoods a checkout-local runner:

```json
{ "runner": ["node", "src/cli.mjs"] }
```
