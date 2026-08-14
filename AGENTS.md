# Repository Guidelines

## Branch and PR workflow

- `main` is a protected integration branch. Do not commit, merge, force-push, or push directly to it.
- Create a short-lived branch for every change and open a pull request targeting `main`.
- Do not bypass Git hooks with `--no-verify`. The local hooks block commits and pushes to `main`; GitHub branch protection must also require a pull request and the `Quality` status check.
- Use Conventional Commits, for example `feat(editor): add table controls` or `fix(clipboard): preserve plain text`.

## Tooling

- Use pnpm with Node.js 22 or newer. Keep `pnpm-lock.yaml` in sync with `package.json`; do not edit the lockfile manually.
- Before opening a PR, run `pnpm check`. Run relevant tests whenever they exist.
- Biome owns linting and formatting. Use `pnpm check:fix` for safe automatic fixes.

## Test-driven development

- Develop behaviour changes using the red-green-refactor cycle: first add or update a test that fails for the intended behaviour, then make the smallest change that passes it, and only then refactor.
- Every bug fix must include a regression test that demonstrates the original failure.
- Test public behaviour and edge cases rather than implementation details. Keep tests deterministic and independent.
- If automated coverage is not practical, explain the reason and the manual validation performed in the PR.

## Change scope

- Keep changes focused and avoid unrelated refactors.
- Follow the architecture and constraints documented in `docs/prd-and-tech-design.md`.
