import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

// Must run before any schema calls `.openapi(...)`. Every module in this package imports `z` from here.
extendZodWithOpenApi(z);

export { z };
