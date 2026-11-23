# mend

One patch tool for every AI edit format. `mend` applies an edit written as a
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

Node 22 and its standard library only. See `SPEC.md` in the kit for the
whole contract; `runner.ts` is the kit's trial runner, kept as it is.
