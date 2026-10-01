import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// dist/server/version.js -> package.json at the package root
const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'));
export const VERSION: string = pkg.version;
