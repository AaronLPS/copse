# README restructure — design

*2026-08-07*

## Problem

`README.md` is 415 lines of exhaustive prose — every command's edge cases,
security rationale, and design justifications — which makes it a poor front
page: too long to scan, hard to find the basics in.

## Approved approach

Short README (~90–110 lines) plus dedicated docs pages. Nothing is deleted,
only relocated; all internal links updated.

### New README contains

- Logo, one-line pitch, badges.
- 4–6 sentence "why": the collision + dropped-`.env` problem, what copse
  does and pointedly does not do.
- One simplified lifecycle Mermaid diagram (the sibling-directory diagram
  moves out).
- Quickstart with the real run output.
- The 4-line command table, each command linking to its full docs.
- A minimal `copse.config.json` example linking to the full reference.
- Short status note: not on npm yet; first slice of `docs/DESIGN.md`; a
  3-line "not built yet" summary (front-page question: "why doesn't
  `copse land` work").
- Links footer (CONTRIBUTING, SECURITY, CODE_OF_CONDUCT).

### Relocations

- `docs/commands.md` (new) — full per-command reference: `new`'s steps and
  refusals, `list`'s drift/PR states, `drop`'s refusal-and-rescue behavior,
  `doctor`, plus the `COPSE_DEBUG` debugging section.
- `docs/configuration.md` (new) — full config key table and validation
  rationale, branch-name/directory-name rules, and the naming diagram.
- Security note — `SECURITY.md` already contains all of its content; the
  README keeps one sentence linking there. No additions needed.
- Testing section — already covered by `CONTRIBUTING.md`; README drops it.

## Out of scope

No behavior, code, or test changes. No rewriting of the moved content
beyond what relocation requires (headings, links, brief intros).
