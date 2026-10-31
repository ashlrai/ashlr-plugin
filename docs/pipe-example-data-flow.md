# Pipe grep example: data flow

This traces the [working-directory grep example](ashlr-pipe.md#return-grep-output-from-a-working-directory), also advertised by the [pipe handler](../servers/pipe-server-handlers.ts#L20-L30). Enable `ashlr__pipe` with `ASHLR_PIPE_ENABLE=1` in the server environment and restart the server; registration is conditional on that flag. Replace `my project` with an existing directory inside an allowed project root.

```json
{
  "expr": "return await ctx.grep({ pattern: 'TODO', cwd: 'my project' });"
}
```

1. **Request and execution.** The [handler schema](../servers/pipe-server-handlers.ts#L31-L56) requires `expr`. The [handler](../servers/pipe-server-handlers.ts#L57-L66) passes the arguments and tool-call context to `ashlrPipe`. That function [validates the expression and limits](../servers/pipe-server.ts#L174-L226), builds a strict async function with `ctx`, and executes it with a deadline ([source](../servers/pipe-server.ts#L228-L257)). The inner `cwd` belongs to the grep call; it is not the optional top-level pipe `cwd`.
2. **Dispatch.** `ctx.grep` forwards `{ pattern: 'TODO', cwd: 'my project' }` to the registered `ashlr__grep` handler with the parent context. It does not set `bypassSummary`, so grep's default applies. The proxy joins the returned content blocks' text with no separator, caps large intermediate text, and returns a string to the expression ([source](../servers/pipe-server.ts#L118-L148)). The [grep handler](../servers/grep-server-handlers.ts#L46-L59) passes the pattern and directory to `ashlrGrep` and wraps its text in a content block. Grep [checks the directory against allowed roots](../servers/grep-server.ts#L198-L208); its actual output depends on the search and may include status or error text.
3. **Intermediate value.** Suppose grep returns this illustrative text, with a newline after each line:

   ```text
   my project/file.ts:1:TODO first
   status: done
   ```

   `await` resolves to the single string `"my project/file.ts:1:TODO first\nstatus: done\n"`. The expression returns it unchanged; no splitting, filtering, or extraction occurs.
4. **Returned value.** `ashlrPipe` JSON-serializes the expression's string and applies the final output limit ([source](../servers/pipe-server.ts#L259-L277)). The handler places that serialized text in one MCP text content block ([source](../servers/pipe-server-handlers.ts#L61-L65)). With this small example and the default limit, the response is:

   ```json
   {"content":[{"type":"text","text":"\"my project/file.ts:1:TODO first\\nstatus: done\\n\""}]}
   ```

   The outer JSON describes the response object. Its `text` field is itself a JSON-encoded string: parsing that field once recovers the original grep text, including newlines. It is not an array of matches. Intermediate data stays server-side, but this expression deliberately returns all of its intermediate string.

The intermediate cap can change the string before it is returned; the final cap defaults to 4096 bytes and appends a truncation marker, so truncated `text` need not be valid JSON. A grep status or error message can also be returned as ordinary text. Errors thrown by the pipe instead take the handler's `ashlr__pipe error` path. For a transforming example and its limitations, see the [file-and-line walkthrough](pipe-grep-example-walkthrough.md).
