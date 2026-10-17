import { createApp } from './bootstrap';
import { loadConfig } from './config/config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.API_PORT);
  console.log(`API listening on http://localhost:${config.API_PORT} (docs: /docs, spec: /v1/openapi.json)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
