// Registers and invokes pipeline plugins. Plugins are added explicitly (no
// dynamic import, no sandbox); the registry is built from config in
// src/plugins/index.ts.
//
// Behavior:
// - Hooks are called in registration order.
// - A plugin that throws in `errorMode: 'continue'` mode is logged with its
//   name + the hook + a redacted payload, and the pipeline keeps going.
// - A plugin in `errorMode: 'halt'` mode rethrows the error after logging.
// - Slow plugins are flagged: any hook taking > 1000ms is logged at warn.
// - Returning a non-void value means the next plugin sees the mutated input
//   (chained transforms). Returning void means "no change".
// - For `onFileDiscovered` only: returning `null` is a deliberate skip and
//   short-circuits — subsequent plugins are not called for that file.

import { createChildLogger } from '../shared/logger.js';
import type {
  OnDocumentCompletedCtx,
  OnDocumentParsedCtx,
  OnDocumentRemovedCtx,
  OnEntitiesExtractedCtx,
  OnFileDiscoveredCtx,
  OnRunCompletedCtx,
  PipelinePlugin,
  PluginRegistration,
} from './interfaces.js';

const log = createChildLogger('plugins.manager');

const SLOW_THRESHOLD_MS = 1000;

// Sentinel returned by onFileDiscovered to skip a file.
export const PLUGIN_SKIP_FILE = null;

export class PluginManager {
  private readonly plugins: PluginRegistration[] = [];

  register(reg: PluginRegistration): void {
    this.plugins.push(reg);
    log.info({ plugin: reg.plugin.name, errorMode: reg.errorMode }, 'plugin.registered');
  }

  has(name: string): boolean {
    return this.plugins.some((p) => p.plugin.name === name);
  }

  list(): { name: string; errorMode: 'continue' | 'halt' }[] {
    return this.plugins.map((p) => ({ name: p.plugin.name, errorMode: p.errorMode }));
  }

  // onFileDiscovered: chained mutation, with a `null` short-circuit signal.
  async runOnFileDiscovered(
    ctx: OnFileDiscoveredCtx
  ): Promise<OnFileDiscoveredCtx | null> {
    let current = ctx;
    for (const reg of this.plugins) {
      if (!reg.plugin.onFileDiscovered) continue;
      const result = await this.invoke(reg, 'onFileDiscovered', () =>
        // biome-ignore lint/style/noNonNullAssertion: presence checked above
        reg.plugin.onFileDiscovered!(current)
      );
      if (result === PLUGIN_SKIP_FILE) {
        log.info({ plugin: reg.plugin.name, filePath: ctx.job.filePath }, 'plugin.file_skipped');
        return null;
      }
      if (result && typeof result === 'object') {
        current = { job: result };
      }
    }
    return current;
  }

  async runOnDocumentParsed(ctx: OnDocumentParsedCtx): Promise<OnDocumentParsedCtx> {
    let current = ctx;
    for (const reg of this.plugins) {
      if (!reg.plugin.onDocumentParsed) continue;
      const result = await this.invoke(reg, 'onDocumentParsed', () =>
        // biome-ignore lint/style/noNonNullAssertion: presence checked above
        reg.plugin.onDocumentParsed!(current)
      );
      if (result) current = { ...current, parsed: result };
    }
    return current;
  }

  async runOnEntitiesExtracted(
    ctx: OnEntitiesExtractedCtx
  ): Promise<OnEntitiesExtractedCtx> {
    let current = ctx;
    for (const reg of this.plugins) {
      if (!reg.plugin.onEntitiesExtracted) continue;
      const result = await this.invoke(reg, 'onEntitiesExtracted', () =>
        // biome-ignore lint/style/noNonNullAssertion: presence checked above
        reg.plugin.onEntitiesExtracted!(current)
      );
      if (result instanceof Map) current = { ...current, extractions: result };
    }
    return current;
  }

  async runOnDocumentCompleted(ctx: OnDocumentCompletedCtx): Promise<void> {
    for (const reg of this.plugins) {
      if (!reg.plugin.onDocumentCompleted) continue;
      await this.invoke(reg, 'onDocumentCompleted', () =>
        // biome-ignore lint/style/noNonNullAssertion: presence checked above
        reg.plugin.onDocumentCompleted!(ctx)
      );
    }
  }

  async runOnDocumentRemoved(ctx: OnDocumentRemovedCtx): Promise<void> {
    for (const reg of this.plugins) {
      if (!reg.plugin.onDocumentRemoved) continue;
      await this.invoke(reg, 'onDocumentRemoved', () =>
        // biome-ignore lint/style/noNonNullAssertion: presence checked above
        reg.plugin.onDocumentRemoved!(ctx)
      );
    }
  }

  async runOnRunCompleted(ctx: OnRunCompletedCtx): Promise<void> {
    for (const reg of this.plugins) {
      if (!reg.plugin.onRunCompleted) continue;
      await this.invoke(reg, 'onRunCompleted', () =>
        // biome-ignore lint/style/noNonNullAssertion: presence checked above
        reg.plugin.onRunCompleted!(ctx)
      );
    }
  }

  // Internal: run a plugin hook with timing + error-mode handling.
  private async invoke<T>(
    reg: PluginRegistration,
    hook: string,
    fn: () => Promise<T> | T
  ): Promise<T | undefined> {
    const start = Date.now();
    try {
      const result = await fn();
      const took = Date.now() - start;
      if (took > SLOW_THRESHOLD_MS) {
        log.warn(
          { plugin: reg.plugin.name, hook, durationMs: took },
          'plugin.slow_hook'
        );
      }
      return result === undefined ? undefined : (result as T);
    } catch (e) {
      const took = Date.now() - start;
      log.error(
        {
          plugin: reg.plugin.name,
          hook,
          durationMs: took,
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        },
        'plugin.hook_failed'
      );
      if (reg.errorMode === 'halt') throw e;
      return undefined;
    }
  }
}
