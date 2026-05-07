// Plugin registry — the single place where the pipeline learns about the
// available plugins. We do not load plugins dynamically (no eval, no
// dynamic-import-from-disk); operators add a plugin here, then enable it
// in config/default.toml.

import type { CostController } from '../extraction/cost-controller.js';
import type { PluginEntry } from '../shared/config.js';
import { ConfigError } from '../shared/errors.js';
import { ConfidenceFilterPlugin } from './confidence-filter.js';
import { CostReporterPlugin } from './cost-reporter.js';
import { DomainTaggerPlugin } from './domain-tagger.js';
import type { PipelinePlugin } from './interfaces.js';
import { PluginManager } from './plugin-manager.js';

export { PluginManager, PLUGIN_SKIP_FILE } from './plugin-manager.js';
export {
  ConfidenceFilterPlugin,
  type ConfidenceFilterOptions,
} from './confidence-filter.js';
export { CostReporterPlugin, type CostReporterOptions } from './cost-reporter.js';
export { DomainTaggerPlugin, type DomainTaggerOptions } from './domain-tagger.js';
export type {
  PipelinePlugin,
  PluginRegistration,
  OnFileDiscoveredCtx,
  OnDocumentParsedCtx,
  OnEntitiesExtractedCtx,
  OnDocumentCompletedCtx,
  OnDocumentRemovedCtx,
  OnRunCompletedCtx,
} from './interfaces.js';

export interface PluginRuntimeDeps {
  costController?: CostController | null;
}

// Static factory mapping plugin name → constructor. Adding a new plugin is
// a 3-line change here plus a class file.
export function buildPlugin(
  entry: PluginEntry,
  deps: PluginRuntimeDeps = {}
): PipelinePlugin {
  switch (entry.name) {
    case 'confidence-filter':
      return new ConfidenceFilterPlugin(entry.options as never);
    case 'cost-reporter':
      if (!deps.costController) {
        throw new ConfigError(
          'cost-reporter plugin requires a cost controller; none was provided',
          { plugin: entry.name }
        );
      }
      return new CostReporterPlugin({ costController: deps.costController });
    case 'domain-tagger':
      return new DomainTaggerPlugin(entry.options as never);
    default:
      throw new ConfigError(
        `Unknown plugin: ${entry.name}. Available: confidence-filter, cost-reporter, domain-tagger.`,
        { plugin: entry.name }
      );
  }
}

export function buildPluginManager(
  entries: PluginEntry[],
  deps: PluginRuntimeDeps = {}
): PluginManager {
  const manager = new PluginManager();
  for (const entry of entries) {
    const plugin = buildPlugin(entry, deps);
    manager.register({ plugin, errorMode: entry.errorMode });
  }
  return manager;
}
