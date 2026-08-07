# README rework report

## New structure

Front matter is now: title → one-line tagline → badge row → 3-sentence
problem statement → table of contents → "See it work" (the UX-flow Mermaid
diagram) → Quickstart → Command reference (grouped subsections for `new`,
`list`, `drop`, `doctor`) → `copse.config.json` reference table → Branch and
directory naming (with the layout Mermaid diagram) → Security note →
Debugging → Not built yet → Testing.

No prose was deleted. The original 328-line linear document was
reorganized so a first-time reader gets "what is this / do I want it" in
the tagline + badges + problem statement, "show me it working" in the
See-it-work diagram and Quickstart, and everything else stays as reference
material below, in the same order and wording as before (only headers were
promoted/regrouped and a "Command reference" umbrella heading was added
over the existing `new`/`list`/`drop`/`doctor` subsections, which were
already present).

## Diagrams and how they were validated

Two Mermaid diagrams were added, both under `See it work` and `Branch names
and directory names`.

1. **UX flow** (`flowchart TD`) — `copse new feat/inbox-filter` → new
   sibling worktree → work happens → `copse list` (showing PR state, using
   the real string `"PR #12 merged — droppable"`, quoted and with the em
   dash intact) → `copse drop feat/inbox-filter` → a diamond decision node
   `anything to lose?` with two branches: the refusal branch (dirty tree /
   unpushed commits → "refuses: lists every reason at once" → fix it → loop
   back to `drop`) and the happy branch (clean and pushed → rescue files →
   remove directory → branch left behind). The refusal is a first-class
   branch of the diagram, not a footnote, per the requirement that refusing
   well is the point of `drop`.

2. **Directory layout** (`flowchart LR`) — a subgraph `/home/me/ws`
   containing the main worktree `proj` (holds `.git`, on `main`) with two
   flat-sibling worktrees `proj-feat-inbox-filter` and `proj-fix-null-check`
   connected by dotted "flat sibling" edges, plus a small derived-name
   mapping `feat/inbox-filter` --`slugFor: / becomes -`--> `proj-feat-inbox-filter`.

**Validation method**: installed `@mermaid-js/mermaid-cli` (`mmdc`) via
`npm install --no-save --prefix <scratch>/mmdc-check @mermaid-js/mermaid-cli`
in the scratch directory (188 packages, ~55s). Headless Chromium needed
`--no-sandbox --disable-setuid-sandbox` via a `puppeteer-config.json` to run
in this container. Extracted the two ` ```mermaid ` fenced blocks
programmatically straight out of the final `README.md` (not from a separate
draft) with a small Python script, fed each one to `mmdc -i block.mmd -o
block.svg`, and confirmed both exited 0 and produced non-trivial SVG output
(26KB and 15KB respectively) with no parse errors. Also rendered PNGs and
visually inspected them — labels containing `/`, `<br/>`, `#`, quotes, and
the em dash all rendered as intended text, nothing broke Mermaid's parser.
Every label in both diagrams is double-quoted; the only literal `/` or `#`
characters appear inside quoted strings, and the one literal double-quote
needed inside a label (`"PR #12 merged — droppable"`) is written as the
HTML entity `&quot;` so it doesn't collide with the surrounding quote
delimiter.

No hardcoded colors or custom Mermaid theme were used — both diagrams rely
entirely on Mermaid's default styling, so they stay readable on GitHub's
light and dark theme.

## Commands re-run and their real output

All verification was done in a throwaway repo under
`$TMP/scratchpad/copse-verify` (created with `git init --bare` as a fake
`origin`, a `proj` checkout with a committed `.gitignore`d `.env.test` and a
`copse.config.json` declaring `carryFiles: [".env.test"]`), run against
`node /home/aiam/ttm_ws/grove/src/cli.mjs` directly (the actual source, not
a copy), then deleted afterward (`rm -rf`) — never against the grove repo
itself.

- `copse new feat/inbox-filter` — output matched the README's existing
  pasted transcript exactly (fetching → worktree path/branch line → carrying
  `.env.test` → success + `cd` hint), aside from the throwaway repo's path
  standing in for `/home/me/ws/...`. Confirmed `.env.test` and its real
  content existed inside the new worktree afterward.
- `copse list` — printed both worktrees (`proj` main, `proj-feat-inbox-filter`)
  each followed by `PR state unknown` (no `gh` reachable in this
  environment, matching the existing README caveat), plus `✓ every
  directory name matches its branch`.
- `copse drop feat/inbox-filter` while **inside** the worktree with an
  untracked file present — refused with both `you are currently in this
  worktree — cd elsewhere first` and `uncommitted changes in the working
  tree`, exit code 1. This confirmed the refusal branch of the flow diagram
  is real behavior, not aspirational.
- After removing the untracked file and `cd`-ing out: `copse drop
  feat/inbox-filter` succeeded — `→ removing ...` then `✓ removed. The
  branch feat/inbox-filter still exists — delete it with: git branch -d
  feat/inbox-filter`, exit code 0 — matching the README's existing pasted
  transcript.
- `copse doctor` — printed `✓ copse: nothing to report`, exit 0.

None of these transcripts changed in wording from the pre-existing README
(they were already accurate), so the README text was left byte-identical to
the previously-verified copy; this run reconfirmed it's still true of the
current source rather than replacing it with new text.

## Facts re-verified against source

- `src/cli.mjs`: exact `USAGE` text, the four implemented commands
  (`new`/`list`/`drop`/`doctor`), the `COPSE_DEBUG` truthiness rule
  (`!['', '0', undefined].includes(...)`), and that every thrown error
  (not just `CopseError`) is funneled through the same `die()` path.
- `src/config.mjs`: `DEFAULTS` (`baseBranch: "main"`, `branchPrefixes:
  ["feat","fix","docs","chore"]`, `carryFiles: []`, `carryDirs: []`,
  `install: null`), the unknown-key rejection, the hyphen-in-prefix
  rejection and its stated reason, the four carried-path rejections
  (absolute, `..` segment, backslash, symlink-escape-at-copy-time), the
  carryFiles/carryDirs overlap check, and that `install` must be `null` or
  a non-empty array of non-empty strings.
- `package.json`: zero `dependencies`, `engines.node: ">=20"`, `bin.copse`,
  `license: MIT`, repository URL `AaronLPS/copse`, and confirmed
  `LICENSE` exists at the repo root (the new license badge links to it).
- `npm test` (`node --test test/*.mjs`): 80/80 passing, both before and
  after the README edit (no source files were touched).
- Confirmed `docs/DESIGN.md` still lists `init`, `land`, `verify`,
  `protect`, `hook`, git hooks, CI generation, Claude Code settings block,
  and port diagnosis as design-only, not implemented — matching the "Not
  built yet" section, which was left unchanged.

## Deliberately left out / unchanged

- No CI badge (CI does not exist yet; a separate change adds one).
- No npm version badge (package unpublished; would render as an error).
- No logo, screenshot, or image file — Mermaid and text only.
- No adoption claims, benchmarks, or roadmap dates.
- No links to CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/issue templates or a CI
  workflow file — none of these exist in the repo yet.
- No changes under `src/` or `test/`, and no `docs/plans/` edits.
- The prose content of every existing section (`new`, `list`, `drop`,
  `doctor`, config table, security note, debugging, not-built-yet, testing)
  is unchanged from the prior README — only its position, heading level,
  and surrounding scaffolding (TOC, badges, diagrams) changed.

## Verification housekeeping

- `npm test` run twice (before touching README, and after): 80/80 both
  times.
- All README-internal `#anchor` links checked programmatically against the
  actual GitHub-style slugs generated from every header in the final file;
  all resolve, none dangling.
- Throwaway verification repo (`$TMP/scratchpad/copse-verify`) deleted
  after use. The `mmdc-check` scratch install and rendered SVG/PNG/`.mmd`
  files used for diagram validation live only under the scratchpad
  directory, not in the repository.
- `git status --porcelain` at completion shows only `README.md` modified,
  matching the "documentation only" scope of this change.
