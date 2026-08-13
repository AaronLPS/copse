# copse parallel-work contract

- Keep the main worktree on the configured base branch; do feature work in a copse worktree.
- Start feature sessions with `copse start <prefix>/<lower-kebab> --agent codex|claude`.
- Run `copse verify` before declaring work complete and `copse land` to merge.
- Never remove worktrees with raw Git; use `copse drop` so carried files are rescued.
