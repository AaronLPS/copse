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

`copse init --runner-package <package-spec>` is the bootstrap-safe way to set
`runner`: it writes `["npx", "--yes", "<package-spec>"]` before reconciling
Git, Codex, Claude, and CI forwards. Package specs remain single argv elements,
not shell source. The previous Git hook directory is intentionally not part of
this committed schema; each clone stores it locally as
`copse.previousHooksPath` and activates the committed `.copse/hooks` wrappers.

`ciMode: auto` detects `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, or
`package.json`. Every generated workflow installs Node because copse itself
requires it, but only npm/pnpm/yarn modes install project dependencies.

Resource names such as `port:3000`, `db:test`, or `emulator:ios` are mutexes.
Claims reserve them until release; resources passed only to `start` follow its
session lease and are released on exit.

Coordination mutations use uniquely named, owner-stamped lock contenders. A
proven-dead local owner or a contender older than the bounded recovery timeout
is reclaimed after a crash; unique contender paths make that reclamation safe
when several sessions race. A live or recent unknown owner continues to block
concurrent mutation.

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

Bootstrap from GitHub in one invocation (pin a reviewed commit or tag for
production use):

```sh
npx github:AaronLPS/copse init --apply \
  --runner-package github:AaronLPS/copse
```

After npm publication, select the pinned package release explicitly:

```sh
npx copse@0.4.0 init --apply --runner-package copse@0.4.0
```

copse itself dogfoods a checkout-local runner:

```json
{ "runner": ["node", "src/cli.mjs"] }
```

## Git hook coexistence

`init --apply` installs executable copse-owned wrappers at
`.copse/hooks/pre-commit` and `.copse/hooks/pre-push`. The wrappers run copse
policy first, then resolve and invoke the corresponding executable hook from
`copse.previousHooksPath` with the original arguments and status. `pre-push`
also replays the exact stdin ref-update stream to both hooks. Missing or
non-executable previous hooks are skipped; invalid paths and delegation cycles
are reported by `copse doctor`.

The clone-local previous value is the prior `core.hooksPath` verbatim, or
`<default>` for the common `.git/hooks` directory. Existing hook files are
never edited or removed, and repeated init does not replace the saved path with
`.copse/hooks`.
