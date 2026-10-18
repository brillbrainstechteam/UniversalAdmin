import { defineConfig } from 'drizzle-kit';
import './src/env';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/schema.ts', './src/catalog-schema.ts', './src/jewellery-schema.ts'],
  out: './migrations',
  dbCredentials: { url: process.env.DATABASE_OWNER_URL ?? '' },
  strict: true,
  verbose: true,
});
