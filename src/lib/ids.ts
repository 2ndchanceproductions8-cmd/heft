// crypto.randomUUID only exists in secure contexts (https / localhost). When the dev server is
// opened from a phone over plain-http LAN it is missing, so fall back to getRandomValues/Math.random.
export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 16);
  const bytes = new Uint8Array(8);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
