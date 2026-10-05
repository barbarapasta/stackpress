# Task 00001A: Fix Root Build Order

## Task Summary

Side quest of [Task 00001](00001-harden-key-verification.md). A clean root
`yarn build` fails at `stackpress-ai`: the root `build:util` script builds `ai`
before `build:main` builds `api`, and `ai` imports `stackpress-api` types. The
defect predates this spec and was found while recording the task 1 baseline.

Added without waiting for review because it is plainly required and has no
meaningful alternative: every later task verifies with a root build, and task
00009 requires it to pass.

## Implementation Steps

1. In the root `package.json`, build `ai` after `api`. Move `yarn ai build` out
   of `build:util` and into `build:main`, between `yarn api build` and
   `yarn stackpress build`.
2. Change nothing else in the root scripts.

## Verification Process

- Remove every package's `cjs/` and `esm/` output, then run `yarn build` at the
  repository root with Node 22. It completes without errors.
- `git diff --check`.

## Acceptance Criteria

Acceptance: not applicable. A build order fix has no meaningful visual output.

## Implementation Notes

Done as written. In the root `package.json`, `yarn ai build` moved out of
`build:util` and into `build:main`, between `yarn api build` and
`yarn stackpress build`. No other script changed.

## Verification Notes

Run with Node 22.23.2 and Yarn 1.22.22.

- Removed `cjs/` and `esm/` from every directory under `packages/`, then ran
  `yarn build` at the repository root: exit 0, "Done in 52.69s", no errors in the
  log. Run again at the end of task 00002 after later source changes, from a clean
  state again: exit 0, "Done in 53.89s".
- The root build does not build `stackpress-desktop` (it has its own
  `build:desktop`). The clean-out removed the desktop output too, so
  `yarn build:desktop` was run afterwards to put it back; `templates/blog` imports
  `stackpress-desktop/plugin`.
- `git diff --check`: clean.

## Acceptance Notes

Accepted by the user on 2026-10-05, after reviewing the results ("Looks good to me").
