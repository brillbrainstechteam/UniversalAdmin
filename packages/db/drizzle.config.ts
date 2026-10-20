import { defineConfig } from 'drizzle-kit';
import './src/env';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/schema.ts',
    './src/catalog-schema.ts',
    './src/jewellery-schema.ts',
    './src/inventory-schema.ts',
    './src/integrations-schema.ts',
    './src/pricing-schema.ts',
    './src/orders-schema.ts',
    './src/b2b-schema.ts',
    './src/b2c-schema.ts',
    './src/growth-schema.ts',
    './src/ops-schema.ts',
  ],
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? '' },
  strict: true,
  verbose: true,
});
