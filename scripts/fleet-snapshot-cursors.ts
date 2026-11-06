import { randomBytes } from "node:crypto";

// Per-server ephemeral inventory. Both limits apply to the raw cursor bytes.
export class SnapshotCursorCache {
  private readonly entries = new Map<string, { cursor: string; bytes: number }>();
  private bytes = 0;
  constructor(private readonly maxCount = 64, private readonly maxBytes = 4 * 1024 * 1024) {}

  get(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("invalid snapshot cursor");
    const entry = this.entries.get(id);
    if (!entry) throw new Error("invalid snapshot cursor");
    return entry.cursor;
  }

  put(cursor: string): string {
    const bytes = Buffer.byteLength(cursor);
    if (bytes > this.maxBytes || this.maxCount < 1) throw new Error("snapshot cursor too large");
    while (this.entries.size >= this.maxCount || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
    const id = randomBytes(16).toString("hex");
    this.entries.set(id, { cursor, bytes });
    this.bytes += bytes;
    return id;
  }
}
