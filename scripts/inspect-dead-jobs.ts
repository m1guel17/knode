// Inspect the dead-letter queues. Usage: npx tsx scripts/inspect-dead-jobs.ts

import { Queue } from 'bullmq';
import { loadConfig } from '../src/shared/config.js';
import {
  FILE_DEAD_QUEUE,
  RESOLUTION_DEAD_QUEUE,
} from '../src/scanner/queue.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const url = new URL(config.scanner.queue.redisUrl);
  const connection = {
    host: url.hostname,
    port: url.port ? Number.parseInt(url.port, 10) : 6379,
  };

  for (const name of [FILE_DEAD_QUEUE, RESOLUTION_DEAD_QUEUE]) {
    const q = new Queue(name, { connection });
    const jobs = await q.getJobs(['completed', 'waiting', 'active', 'delayed', 'failed'], 0, 49);
    console.log(`\n=== ${name} (${jobs.length} jobs) ===`);
    for (const job of jobs) {
      console.log(JSON.stringify({ id: job.id, data: job.data }, null, 2));
    }
    await q.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
