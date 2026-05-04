export { classifyFile } from './classifier.js';
export type { ClassifyOptions } from './classifier.js';
export { ProcessingLog } from './processing-log.js';
export type { ProcessingLogEntry, ProcessingStatus } from './processing-log.js';
export {
  JobQueues,
  FILE_QUEUE,
  RESOLUTION_QUEUE,
  FILE_DEAD_QUEUE,
  RESOLUTION_DEAD_QUEUE,
  priorityForSize,
} from './queue.js';
export type { FileJobPayload, ResolutionJobPayload, QueueDeps } from './queue.js';
export { startWorkers } from './worker.js';
export type { WorkersDeps, RunningWorkers } from './worker.js';
export { walkFolder } from './folder-walker.js';
export type { WalkOptions } from './folder-walker.js';
