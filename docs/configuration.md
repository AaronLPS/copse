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
| `leaseTimeoutSeconds` | `300` | positive integer; dead/expired sessions may be reclaimed |
| `leaseHeartbeatSeconds` | `30` | positive integer shorter than the lease timeout |
| `resources` | `{}` | feature branch to shared resource-name arrays |
| `coordinationBackend` | `local` | `local` Git-common state or `committed` reviewed state |
| `ciMode` | `auto` | `auto`, `npm`, `pnpm`, `yarn`, `custom`, or `none` |
| `ciSetup` | `[]` | argv arrays used only by custom CI setup |

Command values are arrays so elements are passed directly to child processes
and cannot become shell operators. Absolute paths, `..`, and backslashes are
refused for carried and coordination paths. Carried leaf and intermediate
symlinks are checked again at copy time; `carryDirs` trees are also walked and
refuse every nested symlink before copying or rescue begins.

`ciMode: auto` detects `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, or
`package.json`. Every generated workflow installs Node because copse itself
requires it, but only npm/pnpm/yarn modes install project dependencies.

Resource names such as `port:3000`, `db:test`, or `emulator:ios` are mutexes.
Claims reserve them until release; resources passed only to `start` follow its
session lease and are released on exit.

Coordination mutations use owner-stamped lock files. A proven-dead local owner
or a lock older than the bounded recovery timeout is reclaimed after a crash;
a live or recent unknown owner continues to block concurrent mutation.

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
