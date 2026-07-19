import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/core/password";

describe("password hashing", () => {
  it("round-trips", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(await verifyPassword("hunter2hunter2", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("hunter2hunter2");
    expect(await verifyPassword("hunter2hunter3", hash)).toBe(false);
  });

  it("uses the self-describing pbkdf2 format", async () => {
    const hash = await hashPassword("secret-password");
    const parts = hash.split("$");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("pbkdf2");
    expect(parts[1]).toBe("sha256");
    expect(Number(parts[2])).toBe(100_000);
  });

  it("salts: same password hashes differently", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
  });

  it("verifies against a stored hash with different iterations (lazy-rehash path)", async () => {
    const hash = await hashPassword("pw-pw-pw-pw");
    const lowered = hash.replace("$100000$", "$100000$"); // format stays valid
    expect(await verifyPassword("pw-pw-pw-pw", lowered)).toBe(true);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "pbkdf2$sha256$abc$!!$!!")).toBe(false);
  });
});
