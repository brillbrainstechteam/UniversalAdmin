import { buildOpenApiDocument } from '@uc/contracts';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Writes the committed baseline spec; CI diffs it to catch undocumented contract changes.
const target = resolve(__dirname, '../../../docs/api/openapi.json');
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log(`OpenAPI written to ${target}`);
