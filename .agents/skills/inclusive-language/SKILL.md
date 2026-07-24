---
name: inclusive-language
description: >
  Keeps identifiers, user-facing strings, and docs free of non-inclusive
  terminology. Use this skill when:
  (1) naming variables, functions, files, branches, or other identifiers,
  (2) writing user-facing strings, UI copy, or error messages,
  (3) writing or editing documentation, comments, or commit messages,
  (4) reviewing terminology (e.g. replacing allowlist/blacklist with
  allowlist/blocklist).
  Routes to Microsoft PoliCheck (the authoritative scan in the ADO/1ES release
  pipeline, aka.ms/policheckinfo) plus any committed pre-scan tooling — never
  maintain a word list in this skill.
metadata:
  version: "1.0.0"
---

# Inclusive Language

Names, strings, comments, and docs must use inclusive terminology. This is a
release-gating requirement scanned by Microsoft PoliCheck.

**Do not hardcode or maintain a term/word list in this skill.** The authoritative,
continuously-updated term list lives in PoliCheck. Duplicating it here would drift
and give a false sense of coverage.

## When this applies

Whenever you name something (variables, functions, files, branches, config keys,
identifiers) or write human-readable text (UI copy, error messages, docs,
comments, commit messages). A representative concern is the historic
`allowlist` → `allowlist` / `blacklist` → `blocklist` cleanup — prefer the
inclusive term by default.

## Source of truth

- **PoliCheck** is the authoritative scan. It runs in the Microsoft ADO / 1ES
  release pipeline. See **aka.ms/policheckinfo** for how it works, term
  categories, and the suppression/exclusion process.
- **Any committed pre-scan tooling in this repo** is the local shortcut. Discover
  it — check `package.json` `scripts` and `.github/workflows/` for an
  inclusive-language / policheck step — and run it before pushing if present.
  Do not assume the command name; verify it against the repo.

## What to do

1. Default to inclusive terminology as you write.
2. If a committed pre-scan tool exists, run it locally before pushing.
3. Treat PoliCheck in the release pipeline as the gate of record.

## On a flag

Rename per PoliCheck's guidance. For genuine false positives (e.g. a third-party
API name you cannot change), use PoliCheck's official exclusion/suppression
process — not an ad-hoc allowlist in this repo or this skill.
