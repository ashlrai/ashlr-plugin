import { expect, test } from "bun:test";
import { SnapshotCursorCache } from "../scripts/fleet-snapshot-cursors";

test("cursor cache enforces count and byte bounds and isolates instances", () => {
  const cache = new SnapshotCursorCache(2, 5), other = new SnapshotCursorCache(2, 5);
  const first = cache.put("aa"), second = cache.put("bb");
  expect(() => other.get(first)).toThrow();
  const third = cache.put("c");
  expect(() => cache.get(first)).toThrow();
  expect(cache.get(second)).toBe("bb");
  const fourth = cache.put("éé");
  expect(() => cache.get(second)).toThrow();
  expect(cache.get(third)).toBe("c");
  expect(cache.get(fourth)).toBe("éé");
  expect(() => cache.put("123456")).toThrow();
  expect(() => cache.get("")).toThrow();
});
