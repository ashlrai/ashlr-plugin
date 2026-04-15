---
name: ashlr-savings
description: Show estimated tokens and cost saved by the ashlr-plugin this session and lifetime.
---

Call the `ashlr__savings` MCP tool and report its output verbatim to the user.

Then append:
- A one-line tip if session savings are 0 ("No ashlr__read/grep/edit calls yet — try using them instead of the built-in tools.")
- The current model in use, so the user understands the dollar value of the saved tokens.
