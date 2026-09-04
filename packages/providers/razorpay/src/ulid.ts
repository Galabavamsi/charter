const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let time = now;
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    timeChars.unshift(CROCKFORD[time % 32] ?? '0');
    time = Math.floor(time / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let entropy = '';
  for (let i = 0; i < 16; i += 1) {
    entropy += CROCKFORD[(bytes[i] ?? 0) % 32];
  }
  return `${timeChars.join('')}${entropy}`.slice(0, 26);
}
