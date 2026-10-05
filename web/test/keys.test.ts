import { describe, expect, it } from "vitest";
import { generateKey, hashKey, isWellFormedKey } from "../src/lib/api.ts";
import * as routerKeys from "../../router/src/keys.ts";

describe("browser-generated API keys", () => {
  it("are in the router's format and hash exactly as the router does", () => {
    for (let i = 0; i < 50; i++) {
      const k = generateKey();
      expect(isWellFormedKey(k)).toBe(true);
      expect(routerKeys.isWellFormedKey(k)).toBe(true);
      expect(hashKey(k)).toBe(routerKeys.hashKey(k));
    }
  });

  it("are unique", () => {
    const keys = new Set(Array.from({ length: 200 }, generateKey));
    expect(keys.size).toBe(200);
  });
});
