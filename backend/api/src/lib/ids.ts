/**
 * Sortable-by-time ids.
 * Not worth pulling in a ULID library, so: timestamp (base32, 48 bits) + randomness.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newId(
  prefix: string,
  now: Date = new Date(),
  // Passing `crypto.getRandomValues` directly as the default calls it detached
  // from crypto. workerd checks the receiver and throws "Illegal invocation" at
  // runtime (Node's crypto tolerates it, so tests never show it).
  // Always call it with crypto as the receiver.
  random: (array: Uint8Array) => Uint8Array = (array) => crypto.getRandomValues(array),
): string {
  const time = encodeTime(now.getTime(), 10);
  const bytes = random(new Uint8Array(10));
  let suffix = "";
  for (const byte of bytes) {
    suffix += ALPHABET[byte % 32];
  }
  return `${prefix}_${time}${suffix}`;
}

function encodeTime(milliseconds: number, length: number): string {
  let value = milliseconds;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    encoded = `${ALPHABET[value % 32]}${encoded}`;
    value = Math.floor(value / 32);
  }
  return encoded;
}

/**
 * Anonymous device id. Accounts are not required, so the client-generated UUID
 * is taken as-is and only its shape is validated.
 */
export function isValidDeviceId(value: string | undefined | null): value is string {
  if (!value) return false;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value,
  );
}
