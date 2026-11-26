import 'reflect-metadata';
import { createApp } from './bootstrap-app';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.API_PORT);
  console.log(`MARIS API listening on :${config.API_PORT}/api/v1`);
}

void main();
