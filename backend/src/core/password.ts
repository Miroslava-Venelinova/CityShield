// PBKDF2-SHA-256 password hashing via WebCrypto (SPEC.md §1.4). BCrypt can't
// run inside the 10 ms CPU budget; PBKDF2 is native in workerd. The format is
// self-describing so iterations can be raised later with lazy rehash on login.

const ITERATIONS = 100_000; // Workers' WebCrypto PBKDF2 iteration cap
const SALT_BYTES = 16;
const HASH_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1) return false;
  let salt: Uint8Array, expected: Uint8Array;
  try {
    salt = fromBase64(parts[3]!);
    expected = fromBase64(parts[4]!);
  } catch {
    return false;
  }
  const actual = await derive(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  // Workers-specific constant-time comparison.
  return crypto.subtle.timingSafeEqual(actual as BufferSource, expected as BufferSource);
}
