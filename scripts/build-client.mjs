/** Serialize the native self-contained DSH client factory. No external bundler. */
import {mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {id,factory} from '../src/client/index.js';

const out = fileURLToPath(new URL('../lib/client.js',import.meta.url));
const body = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(id)},\n  factory: ${factory.toString()}\n});\n`;
mkdirSync(dirname(out),{recursive:true});
writeFileSync(out,body);
console.log(`built lib/client.js (${Buffer.byteLength(body)} bytes)`);
