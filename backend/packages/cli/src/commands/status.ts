import { loadConfig } from '@workjournal/core';

export async function statusCommand() {
  const config = loadConfig();

  try {
    const response = await fetch(`http://${config.host}:${config.port}/api/projects`);
    if (response.ok) {
      console.log(`WorkJournal core service is running at http://${config.host}:${config.port}`);
    } else {
      console.log('Service responded with an error.');
    }
  } catch {
    console.log('WorkJournal core service is not running.');
    console.log('Start it with: pnpm start');
  }
}
