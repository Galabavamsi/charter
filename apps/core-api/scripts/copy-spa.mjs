import { cp, rm } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';

const source = fileURLToPath(new URL('../../concierge-web/dist/', import.meta.url));
const destination = fileURLToPath(new URL('../dist/public/', import.meta.url));

await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
