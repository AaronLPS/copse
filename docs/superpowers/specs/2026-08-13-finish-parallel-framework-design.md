# Complete parallel-work framework hardening design

Date: 2026-08-13

## Goal

Close the remaining gap between copse's worktree lifecycle prototype and a
framework that can be installed into a new or existing repository and safely
run multiple Codex, Claude Code, or custom-command sessions in parallel.

## Scope and ordering

The work is delivered in six ordered slices:

1. Make `start` atomically claim a feature and hold an exclusive live session
   lease for the launched process.
2. Exercise the packed npm artifact through a real consumer CLI lifecycle.
3. Make onboarding work for repositories without `origin` and for npm, pnpm,
   yarn, custom, and non-Node CI setups.
4. Close the pull-request lifecycle by adding PR creation and safer landing,
   including local base refresh after merge.
5. Harden and acceptance-test the Codex and Claude hook adapters while keeping
   Git hooks and CI as the enforcement boundary.
6. Diagnose shared local resources and make coordination state portable when
   a project opts into a committed coordination backend.

## Session leases and ownership

`copse start` accepts `--owner`, defaulting to `<USER>@<hostname>`. It validates
the branch even when a matching worktree already exists, atomically claims an
unclaimed or released feature, and refuses an active claim owned by somebody
else. An active lease refuses every second launch, including one by the same
owner.

Leases live beside the existing coordination state in Git's common directory.
Each lease records a random id, branch, owner, agent/command label, host, parent
PID, child PID when known, creation time, heartbeat time, and expiry time.
Creation and release use the same exclusive coordination lock as feature
updates. A lease is live while its recorded local process exists and its
heartbeat has not exceeded the configured timeout. A dead process or expired
heartbeat is reclaimed on the next start. The launcher uses asynchronous
`spawn`, updates the lease after the child starts, refreshes the heartbeat,
forwards signals, preserves inherited stdio, returns the child exit status,
and releases only the lease id it owns in `finally`.

Configuration adds `leaseTimeoutSeconds` and `leaseHeartbeatSeconds`, with
conservative defaults and validation that the heartbeat is shorter than the
timeout. `list --json` and text output expose active/stale lease state without
printing volatile process details unless JSON is requested.

## Distribution-grade consumer acceptance

The package smoke test becomes an actual packed-artifact acceptance test. It
packs and installs copse into a temporary consumer, creates a real Git remote,
runs the installed CLI through `init --apply`, `doctor`, two claims/worktrees,
hook refusal, verification, simulated PR landing, release, and safe cleanup.
External GitHub operations remain injected or shimmed; no test contacts a live
repository. The test asserts generated runners resolve the installed package,
not the source checkout.

## Repository onboarding

`init` detects Node package managers from lockfiles and accepts an explicit
`--ci npm|pnpm|yarn|custom|none`. Generated workflows use the selected setup
and install command. `custom` and `none` never invent an `npm install` step;
custom projects may supply `ciSetup` argv lists in config. Existing workflows
remain consumer-owned and are never overwritten.

`new` prefers `origin/<baseBranch>` when it exists. Without an origin it uses
the verified local base branch, so a freshly initialized local repository can
start isolated work immediately. Fetch remains the default when a remote is
available. The selected base source is reported explicitly.

Generated forwards use a version-pinned or checkout-local runner. Before npm
publication, `init` invoked from a GitHub/package spec preserves that executable
resolution rather than silently generating an unrelated `npx copse` command.

## Pull requests and landing

Add `copse pr [branch] [--draft]`, which validates a clean pushed feature,
runs verification by default, and invokes `gh pr create` with the configured
base. `land` can create a missing PR only with an explicit `--create-pr` flag;
otherwise its existing refusal remains.

Landing separates the remote merge from local cleanup. It does not ask `gh`
to delete a checked-out local branch. After GitHub reports the PR merged, it
fetches the remote base, fast-forwards the main worktree only when clean and on
the configured base, releases coordination state, removes the feature worktree
through `drop`, and then deletes the local feature branch when safe. Every
partial-success state is reported with a recovery command.

## Hook hardening

Codex and Claude adapters get separate fixtures for their documented event
shapes while sharing pure policy. Tool-name normalization covers current shell
and edit tool names. The pre-tool hook blocks obvious main-worktree mutations
but is explicitly advisory: arbitrary interpreters can write files, so Git
hooks and CI remain authoritative. Generated hook files include a protocol
version, and `doctor` checks both structure and runner resolution.

Real launcher smoke tests feed session-start and pre-tool-use JSON through the
installed CLI and assert stdout plus exit behavior. Product-version-specific
manual acceptance steps remain documented where an automated harness cannot
start an authenticated Codex or Claude session.

## Shared resources and portable coordination

Configuration may declare named resources such as ports, databases, emulators,
or arbitrary mutex names. A claim or start can reserve resources atomically;
conflicting active reservations refuse with owner and feature information.
Leases release their ephemeral reservations on exit. `list` and `doctor` show
stale reservations and listening-port ownership but never start or kill a
process.

The default coordination backend remains local Git-common state for immediate,
non-dirty worktree sharing. Projects may opt into `coordinationBackend:
"committed"`; in that mode claims are written atomically to the configured
coordination file and are suitable for review/synchronization, with explicit
conflict handling. The existing committed seed is actually loaded when local
state is first created.

## Safety and compatibility

- Configured commands remain argv arrays and never pass through a shell.
- Unknown process, Git, PR, hook, or coordination state blocks mutation.
- Existing config defaults retain their behavior.
- All file writes use same-directory temporary files and atomic rename.
- Stale locks include owner metadata and can be recovered only after proving
  the owner process is dead or the lock exceeded its timeout.
- No consumer-owned file is overwritten by `init`.

## Testing and acceptance

Every policy begins with a pure failing test. Real-Git integration tests cover
local-only repositories, remote repositories, duplicate starts, crashed/stale
leases, package-manager detection, hook forwards, PR creation, partial land,
resource conflicts, and both coordination backends. Final acceptance requires:

1. `node src/cli.mjs verify` passes.
2. Coverage remains above 90% line coverage.
3. The packed artifact completes the consumer lifecycle.
4. Two different features can run concurrently while a duplicate start is
   refused.
5. The main worktree remains clean and on `baseBranch` throughout feature work.

