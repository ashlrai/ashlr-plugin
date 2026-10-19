# Team Genome: Sharing a Genome Across a Development Team

A single `.ashlrcode/genome/` directory can be committed to your repository and
shared by every developer on the team. This guide explains how it works, when to
use it, and how to keep it healthy as the codebase evolves.

---

## What a shared genome does

The genome is a pre-summarized retrieval index of your codebase. When the
ashlr-efficiency server receives a `grep` or `read` call, it first checks whether
the genome has a relevant section and returns that instead of scanning raw files.
This cuts token usage by 40-80% on well-indexed repos.

When you commit the genome to the repository:

- Every developer gets the same index on `git clone` or `git pull`.
- `ashlr__grep` returns consistent answers regardless of whose machine runs it.
- Token savings are deterministic per project — the genome ships with cost
  estimates in `manifest.json` that the savings accounting uses.
- New contributors start saving tokens immediately, without running
  `ashlr-genome-init` themselves.

A committed genome also serves as a living architectural digest: reviewers can
read `sections/*.md` to understand how subsystems fit together before touching
code.

---

## Repository layout

After initialization the genome lives entirely inside `.ashlrcode/`:

```
.ashlrcode/
  genome/
    manifest.json          # index metadata, section checksums, cost estimates
    sections/
      architecture.md
      api-surface.md
      data-models.md
      ...                  # one file per logical section
  genome-ignore            # optional exclusion list (see below)
```

`proposals.jsonl` is written locally by the scribe hook during a session. It is
not shared.

---

## Git workflow

### Initial commit

After running `/ashlr-genome-init` (or `ashlr__genome_propose` + consolidate) on
the base branch:

```bash
git add .ashlrcode/genome/
git commit -m "chore: add ashlr genome index"
```

Add this to your project `.gitignore`:

```gitignore
# ashlr genome — commit the genome itself, ignore local proposals
.ashlrcode/proposals.jsonl
.ashlrcode/genome/proposals.jsonl
```

The `sections/` directory and `manifest.json` should be tracked. They are plain
markdown and JSON — readable in any diff tool, no binary blobs.

### Keeping it up to date

The genome does not auto-update itself in CI. Designate one developer per sprint
(or add a `make genome-sync` target) to regenerate it when the codebase drifts:

```makefile
# Makefile
genome-sync:
	git pull --rebase
	bun run $(ASHLR_PLUGIN_ROOT)/scripts/genome-auto-consolidate.ts
	git add .ashlrcode/genome/
	git commit -m "chore: refresh ashlr genome" || true
	git push
```

The consolidation script reads accumulated proposals and merges them into
`sections/*.md`. Run it on a clean working tree so the diff is easy to review.

A practical cadence: run `make genome-sync` after any large refactor, and at
least once per two-week sprint. The genome degrades gracefully — stale sections
return slightly less precise results but never break tool calls.

---

## Conflict resolution

### How conflicts arise

`hooks/genome-scribe-hook.ts` appends to `proposals.jsonl` after each session.
`scripts/genome-auto-consolidate.ts` applies those proposals to `sections/*.md`
at session end. Both operations are local-only.

If two developers run consolidation on diverged branches and both commit updated
sections, a standard merge conflict appears in `sections/<name>.md`.

### Resolution strategy

Genome sections are prose documents. The last consolidator's version wins — there
is no semantic merge logic. Resolve conflicts by accepting one side or
hand-editing to combine the relevant changes, then re-commit.

Recommended approach:

1. Pull the remote genome into your branch before consolidating locally.
2. Run `genome-auto-consolidate.ts`.
3. Commit and push.

```bash
git pull --rebase origin main
bun run /path/to/ashlr-plugin/scripts/genome-auto-consolidate.ts
git add .ashlrcode/genome/
git commit -m "chore: merge genome"
git push
```

If you encounter a conflict during `git pull`:

```bash
# Accept the remote version (safe default — theirs was already reviewed)
git checkout --theirs .ashlrcode/genome/sections/architecture.md
git add .ashlrcode/genome/sections/architecture.md

# Then consolidate your local proposals on top
bun run /path/to/ashlr-plugin/scripts/genome-auto-consolidate.ts
```

Conflicts in `manifest.json` should always be resolved by regenerating the file
via consolidation — do not hand-edit checksums.

---

## genome-ignore: excluding files from the index

Create `.ashlrcode/genome-ignore` at the repository root. One glob pattern per
line. The scribe hook skips any source file whose path matches a listed pattern.

Example `.ashlrcode/genome-ignore`:

```
# Never include secrets or credentials
.env
.env.*
secrets/**
config/credentials.*
**/*.pem
**/*.key

# Generated files add noise
dist/**
build/**
coverage/**
*.min.js
```

Patterns follow the same syntax as `.gitignore`. The ignore file itself should be
committed so every developer's scribe respects the same exclusions.

---

## When not to share a genome

**Small throwaway repositories.** If the project will be deleted or archived
within a few weeks, the overhead of maintaining a genome is not worth it. Skip
the commit — developers can generate a local genome on demand.

**Secrets risk.** The genome embeds excerpts from source files. Any file that
contains secrets — API keys, passwords, private keys — must be excluded via
`genome-ignore` before running the first propose. If a secret is accidentally
indexed, rotate the secret immediately, remove the section from `sections/`,
and force-push or use `git filter-repo` to scrub the history.

Rule of thumb: if a file would be dangerous to share in a public pull request,
add it to `genome-ignore` before running `/ashlr-genome-init`.

**High-churn monorepos.** If hundreds of files change every day, the genome will
be stale by the time it lands on other machines. Prefer per-package genomes
scoped to stable subdirectories, or run `genome-sync` in CI on a nightly schedule
rather than per-commit.

---

## Bootstrapping a new team member

No extra steps are needed beyond the standard clone:

```bash
git clone https://github.com/your-org/your-repo
cd your-repo
bun install   # if ashlr-plugin is a dev dependency
```

The plugin auto-detects `.ashlrcode/genome/` in the current working directory on
startup. If the genome exists, it is used immediately — no initialization
required.

If the new developer's session generates proposals that improve on the committed
genome, they can run `genome-auto-consolidate.ts` locally and open a PR with the
updated sections.

---

## Size considerations

A typical genome for a 50,000-line codebase is 200-500 KB. Sections are Markdown
and compress well in git's object store.

Recommended upper bound: **5 MB total** for the `sections/` directory. Beyond
that, `git clone` and `git pull` times degrade noticeably on slow connections, and
the retrieval index itself becomes slower to scan.

If the genome approaches 5 MB:

- Audit `sections/` for redundant or overly verbose entries.
- Tighten `genome-ignore` to exclude large generated directories.
- Consider splitting the repo into smaller packages, each with its own genome.

Check current size:

```bash
du -sh .ashlrcode/genome/sections/
```

---

## Example: full team workflow end-to-end

```bash
# Tech lead initializes the genome on main
cd /path/to/your-repo
# (in Claude Code with ashlr active)
# /ashlr-genome-init
git add .ashlrcode/genome/
git commit -m "chore: add ashlr genome index"
git push

# Developer clones repo — genome is immediately active
git clone https://github.com/your-org/your-repo
cd your-repo
# ashlr__grep and ashlr__read now use the genome automatically

# After a sprint of changes, refresh the genome
make genome-sync
# opens a PR with updated sections/*.md
```

---

## See also

- `docs/architecture.md` — system architecture overview used as a source for the
  genome's architecture section.
- `/ashlr-genome-init` skill — interactive setup wizard that runs propose +
  consolidate and writes the initial genome.

---

## Backend-hosted genome sync (Pro team tier)

Teams on the `team` plan can host the authoritative genome on the ashlr backend
instead of (or alongside) the git-committed copy. Every developer pulls the
latest sections at session start and pushes their edits back automatically.

### How to opt in

1. Obtain a `ASHLR_PRO_TOKEN` for your org (set in the team billing dashboard).
2. Create a hosted genome:
   ```bash
   curl -X POST https://api.ashlr.ai/genome/init \
     -H "Authorization: Bearer $ASHLR_PRO_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"orgId":"your-org","repoUrl":"https://github.com/your-org/repo"}'
   # → {"genomeId":"...","cloneToken":"gclone_..."}
   ```
3. Export the genome ID in every developer's shell profile or `.env`:
   ```bash
   export ASHLR_TEAM_GENOME_ID=<genomeId>
   export ASHLR_PRO_TOKEN=<token>
   ```

From that point on, `session-start.ts` pulls updates automatically and
`_genome-live.ts` pushes section changes after each `ashlr__edit`.

### Sync flow

```
Session start
  └─ GET /genome/:id/pull?since=<localSeq>
       └─ returns sections modified since last pull
       └─ writes each section to .ashlrcode/genome/sections/<name>.md
       └─ persists new serverSeqNum to ~/.ashlr/genome-seq.json

After ashlr__edit on a genome section
  └─ POST /genome/:id/push { sections:[{path,content,vclock}], clientId }
       └─ server merges vclocks, detects conflicts
       └─ responds { applied:[paths], conflicts:[paths] }
```

### Vector-clock merge algorithm

Each section carries a vector clock `{ [clientId]: count }`.

```
mergeVClocks(a, b)  →  component-wise max of every key in a ∪ b

compareVClocks(incoming, stored):
  if incoming[k] >= stored[k] for all k  →  "dominates"  (safe update)
  if stored[k] >  incoming[k] for any k
     and incoming[k] < stored[k] for any k  →  "concurrent"  (conflict)
  if stored[k] > incoming[k] for all k  →  "dominated"  (stale push)
```

Push semantics by relation:
- **dominates** — section updated, any prior conflict cleared.
- **concurrent** — both variants stored; conflict surfaced via `GET /conflicts`.
- **dominated** — incoming is stale; stored value kept, conflict recorded so
  neither version is lost.

### Conflict example

Developer A and B both edit `sections/auth.md` from the same base:

| Event | Client | vclock stored | vclock incoming | Result |
|-------|--------|---------------|-----------------|--------|
| Push A | `ca`  | `{}`          | `{ca:1}`        | applied, stored = `{ca:1}` |
| Push B | `cb`  | `{ca:1}`      | `{cb:1}`        | concurrent — conflict recorded |

B's push has `cb:1` (new to server) but is missing `ca:1` (server has it). Neither
dominates. Both variants are stored and `GET /genome/:id/conflicts` returns them
with an `authorHint` so the team can choose the winner via
`POST /genome/:id/resolve`.

### Conflict resolution

```bash
# List conflicts
curl https://api.ashlr.ai/genome/$GENOME_ID/conflicts \
  -H "Authorization: Bearer $ASHLR_PRO_TOKEN"

# Resolve — pick the winning content
curl -X POST https://api.ashlr.ai/genome/$GENOME_ID/resolve \
  -H "Authorization: Bearer $ASHLR_PRO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"sections/auth.md","winning":{"content":"...","vclock":{"ca":1,"cb":1}}}'
```

The `/ashlr-genome-conflicts` skill shows unresolved conflicts with a short diff
view inside Claude Code. A full CLI resolver is planned for v2.

### Private vs shared genome trade-offs

| | Git-committed genome | Backend-hosted genome |
|--|----------------------|-----------------------|
| Conflict resolution | Manual merge / PR | CRDT auto-merge |
| Latency to teammates | Next `git pull` | Next session start (~instant) |
| Offline support | Full | Pull/push silently skipped |
| Visibility | Full git history | Push audit log only |
| Setup complexity | None | Requires `ASHLR_TEAM_GENOME_ID` |

For small teams with short PR cycles, the git-committed genome is usually
sufficient. The hosted sync shines when multiple developers are in active Claude
Code sessions simultaneously on the same repo.

### Security

- All requests are authenticated with a bearer token (`ASHLR_PRO_TOKEN`).
- Section paths are sanitized server-side: `..`, absolute paths, and `//`
  patterns are rejected with HTTP 400.
- Content is capped at 1 MB per section.
- Push calls are rate-limited to 10 sections per minute per client.
- Every push is written to an audit log (`genome_push_log`) for Phase 4 audit
  trail integration.
- **Client-side AES-256-GCM encryption is available.** When a team key is
  present at `~/.ashlr/team-keys/<genomeId>.key`, section content is encrypted
  before upload and decrypted after pull. The server stores only ciphertext and
  cannot read section content. See the encryption section below.

---

## Client-side encryption (v1)

### Threat model

| Threat | Mitigation |
|--------|-----------|
| Server operator reads section content | Ciphertext only on server; key never leaves client machines |
| Network observer | TLS + client-side encryption (defence-in-depth) |
| Compromised Redis / S3 / Postgres | Only ciphertext stored; useless without the key |
| User leaves team | Rotate the key; ex-member cannot decrypt new sections |
| Tampered ciphertext | AES-256-GCM auth tag — decryption throws on any modification |

Vector clock (vclock) metadata is transmitted in plaintext so the server can
perform conflict detection without decrypting content.

### Algorithm

- **AES-256-GCM** with a 256-bit key and a 96-bit (12-byte) random nonce per section push.
- The 128-bit GCM authentication tag is verified on every decrypt — any tampering throws.
- Wire format (base64url): `[ version(1 byte) | nonce(12 bytes) | authTag(16 bytes) | ciphertext ]`

### Key setup

Generate a team key once and save it locally:

```bash
bun run scripts/genome-key.ts generate <genomeId>
# Key saved to ~/.ashlr/team-keys/<genomeId>.key (mode 0600)
```

Share it with each team member over a secure channel (Signal, 1Password, etc.):

```bash
# On machine with key:
bun run scripts/genome-key.ts export <genomeId>
# Prints base32-encoded key after confirmation prompt

# On each team member's machine:
bun run scripts/genome-key.ts import <genomeId>
# paste the key when asked (input is hidden), or pipe it on stdin
```

Once the key file exists at `~/.ashlr/team-keys/<genomeId>.key`, every push is
automatically encrypted and every pull automatically decrypted. No other
configuration is needed.

### Key file location and permissions

```
~/.ashlr/team-keys/<genomeId>.key   — 32 raw bytes, mode 0600 (owner read/write only)
```

The file is never logged, never included in git, and never transmitted to the
server. It lives only on developer machines.

### Key rotation

When a team member leaves or a key may be compromised, rotate the key. This
re-encrypts all sections on the server with a new key:

```bash
bun run scripts/genome-key.ts rotate <genomeId>
```

The rotate command:
1. Pulls all sections from the remote.
2. Decrypts each with the current key.
3. Generates a new 32-byte key.
4. Re-encrypts all sections with the new key and pushes them.
5. Saves the new key file locally.

After rotation, distribute the new key to all remaining team members:

```bash
bun run scripts/genome-key.ts export <genomeId>
```

Members who do not receive the new key will see a warning on pull and their
local copy of those sections will not be updated until they import the new key.

### Enforcing encryption org-wide

Org admins can mark a genome as requiring encryption. Pushes from clients
without a key (plaintext content) will be rejected with HTTP 422:

```bash
curl -X PATCH https://api.ashlr.ai/genome/$GENOME_ID/settings \
  -H "Authorization: Bearer $ASHLR_PRO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"encryption_required": true}'
```

### Backward compatibility

The server stores a `content_encrypted` boolean per section. Existing plaintext
sections remain readable by old clients without keys. Mixed teams (some members
with keys, some without) are supported — members without a key simply cannot
read encrypted sections. `encryption_required=true` enforces a clean cutover.

### Migration from plaintext to encrypted

For an existing team genome that has been syncing in plaintext:

1. Generate and distribute a key to all team members (see Key setup above).
2. Run `bun run scripts/genome-key.ts rotate <genomeId>` — this re-encrypts
   all existing plaintext sections on the server.
3. Optionally set `encryption_required: true` to prevent future plaintext pushes.

---

## Multi-user encryption model (v2, not yet shipped)

The v1 model uses a single shared symmetric key. This is simple but requires
out-of-band key distribution and a full rotate when any member leaves.

The v2 model uses asymmetric key wrapping (X25519 / HKDF):

1. **Each member** generates an X25519 keypair. The public key is registered
   with the genome on the server.
2. **The genome** has one symmetric data-encryption key (DEK), the same
   AES-256-GCM key used in v1.
3. **Key envelopes**: the DEK is encrypted once per member using that member's
   X25519 public key (via ECDH + HKDF). The server stores the envelope set:
   `{ memberId → encrypt(memberPublicKey, DEK) }`.
4. **Adding a member**: admin fetches the DEK (decrypts with their own
   envelope), re-wraps it to the new member's public key, pushes a new
   envelope. No re-encryption of section content needed.
5. **Removing a member**: admin removes the member's envelope and rotates the
   DEK (same as v1 rotate, but the new DEK is then wrapped for all remaining
   members). The removed member's envelope is gone; they cannot decrypt the
   new DEK.
6. **Decryption on pull**: client fetches its envelope, decrypts the DEK, then
   decrypts sections exactly as in v1.

Migration from v1 to v2 is non-breaking: the section wire format and
`serializeBlob` encoding are unchanged. Only key delivery changes.

