# Regex replacement: wrapping TODO markers

The `ashlr__search_replace_regex` whole-match example in
[`search-replace-regex.test.ts`](../__tests__/search-replace-regex.test.ts)
starts with a file containing:

```text
TODO: fix
TODO: refactor
```

Use these tool arguments:

```json
{"pattern":"TODO","replacement":"[$&]"}
```

`$&` expands to the entire matched text. The tool replaces each match, so the
expected file contents are:

```text
[TODO]: fix
[TODO]: refactor
```

Both the input and output end with a newline. To preview changes without writing
files, add `"dryRun": true` to the arguments before applying them.
