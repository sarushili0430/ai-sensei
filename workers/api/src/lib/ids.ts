/**
 * 時系列にソートできるID。
 * ULIDのライブラリを足すほどではないので、時刻(base32・48bit)+乱数で作る。
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newId(
  prefix: string,
  now: Date = new Date(),
  random = crypto.getRandomValues,
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
 * 匿名デバイスID。アカウント作成を要求しない方針(handoff §5)なので、
 * クライアントが生成したUUIDをそのまま受け取る。形だけ検証する。
 */
export function isValidDeviceId(value: string | undefined | null): value is string {
  if (!value) return false;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value,
  );
}
