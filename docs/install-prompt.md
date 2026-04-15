# Ask Claude Code to install ashlr for you

Copy everything in the fenced block below and paste it into a Claude Code
session. Claude Code will drive the whole install end-to-end, restart prompts
included, and report the final `/ashlr:ashlr-doctor` result back to you.

---

````
Install the ashlr-plugin for me. Follow these steps in order. Do not skip or
reorder. Report exactly what happened after each step.

1. Run in a Bash shell:
     curl -fsSL https://plugin.ashlr.ai/install.sh | bash
   If it exits non-zero, stop and show me the full stderr. Don't try to
   work around failures — I want to see them.

2. Tell me, in plain English:
     "Fully quit and restart Claude Code now, then tell me when you're back."
   Then stop and wait for me. Do NOT attempt to keep going in this session —
   the plugin only registers after a full restart.

3. Once I confirm the restart in a NEW session, run:
     /plugin marketplace add masonwyatt23/ashlr-plugin
     /plugin install ashlr@ashlr-marketplace
   If either command errors, show the exact error verbatim and stop.

4. Then run:
     /reload-plugins
   This forces Claude Code to pick up the newly installed plugin without
   requiring another restart.

5. Then run:
     /ashlr:ashlr-doctor
   Capture and report the full output. Summarize:
     - total checks
     - passes
     - failures (if any, list each with its message)

6. If /ashlr:ashlr-doctor reports 0 failures, ask me:
     "Doctor is clean. Want me to initialize a genome for this project
      (/ashlr:ashlr-genome-init) and then run the /ashlr:ashlr-tour?"
   Only run those two if I say yes. If I say no, stop here.

Source: https://github.com/masonwyatt23/ashlr-plugin
Landing: https://plugin.ashlr.ai/
License: MIT · No account · Zero telemetry
````

---

That's it. Claude Code runs the shell command, pauses for the restart,
finishes the install in the new session, reloads, self-diagnoses, and
optionally bootstraps a genome + tour. If anything fails along the way,
you'll see the exact error and can decide what to do next.

## If you'd rather do it manually

```bash
# 1. terminal
curl -fsSL https://plugin.ashlr.ai/install.sh | bash
```

Fully restart Claude Code, then inside the new session:

```
/plugin marketplace add masonwyatt23/ashlr-plugin
/plugin install ashlr@ashlr-marketplace
/reload-plugins
/ashlr:ashlr-doctor
```

If doctor is clean:

```
/ashlr:ashlr-genome-init
/ashlr:ashlr-tour
```
