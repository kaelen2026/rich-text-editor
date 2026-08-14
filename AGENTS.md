# Repository Guidelines

## Branch and PR workflow

- `main` is a protected integration branch. Do not commit, merge, force-push, or push directly to it.
- Create a short-lived branch for every change and open a pull request targeting `main`.
- Do not bypass Git hooks with `--no-verify`. The local hooks block commits and pushes to `main`; GitHub branch protection must also require a pull request and the `CI / Quality` status check.
- Use Conventional Commits, for example `feat(editor): add table controls` or `fix(clipboard): preserve plain text`.

## Tooling

- Use pnpm with Node.js 22 or newer. Keep `pnpm-lock.yaml` in sync with `package.json`; do not edit the lockfile manually.
- Before opening a PR, run `pnpm check`. Run relevant tests whenever they exist.
- Biome owns linting and formatting. Use `pnpm check:fix` for safe automatic fixes.

## Change scope

- Keep changes focused and avoid unrelated refactors.
- Follow the architecture and constraints documented in `docs/prd-and-tech-design.md`.
