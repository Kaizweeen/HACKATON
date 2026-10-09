/**
 * Random per-install device id (64 bits, hex). Not derived from anything about the phone or its owner.
 * Uses the platform CSPRNG (browsers in secure contexts, Node >= 19).
 */
export function newDeviceId(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (const b of bytes) id += b.toString(16).padStart(2, '0');
  return id;
}
