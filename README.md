# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Darkarmy921/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Darkarmy921/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It applies an edit written as a
unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A
patch, or JSON tool calls, to a tree of text files, to one specification.

Run it as `node main.ts [options] [PATCH]`, with the working directory as the
root of the tree. When PATCH is absent or is `-`, the patch is read from
standard input.

Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`),
`--check` (do everything but write), `--strict` (exact line matching only).

Edits find the lines they name at the first of three matching tiers: exact,
trailing whitespace ignored, then leading and trailing whitespace ignored,
re-indenting the new lines to the file's own indentation. Every file is
changed or none: a failed edit changes nothing, later edits still run, and
when any edit failed no file is written at all.

Node 22 and its standard library only. `runner.ts` is the kit's trial runner,
kept as it is.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=ppee1fs7&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
