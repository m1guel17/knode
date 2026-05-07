// Drops entities and relationships below configurable confidence floors.
// Useful for noisy domains where the extractor returns too many low-quality
// triples. Implements onEntitiesExtracted; the dropped entities never reach
// the resolver or the graph backend.

import type { ExtractionResult } from '../shared/types.js';
import { createChildLogger } from '../shared/logger.js';
import type {
  OnEntitiesExtractedCtx,
  PipelinePlugin,
} from './interfaces.js';

const log = createChildLogger('plugins.confidence-filter');

export interface ConfidenceFilterOptions {
  minEntityConfidence?: number; // default 0.5
  minRelationshipConfidence?: number; // default 0.6
}

export class ConfidenceFilterPlugin implements PipelinePlugin {
  readonly name = 'confidence-filter';
  private readonly minEntity: number;
  private readonly minRel: number;

  constructor(opts: ConfidenceFilterOptions = {}) {
    this.minEntity = opts.minEntityConfidence ?? 0.5;
    this.minRel = opts.minRelationshipConfidence ?? 0.6;
  }

  async onEntitiesExtracted(
    ctx: OnEntitiesExtractedCtx
  ): Promise<Map<string, ExtractionResult>> {
    let droppedEntities = 0;
    let droppedRelationships = 0;
    const filtered = new Map<string, ExtractionResult>();

    for (const [chunkId, result] of ctx.extractions) {
      const keptEntities = result.entities.filter((e) => {
        if (e.confidence >= this.minEntity) return true;
        droppedEntities++;
        return false;
      });
      // After dropping low-confidence entities, drop any relationship whose
      // endpoints are no longer present — otherwise the graph writer will
      // log a missing-endpoint warning for them.
      const keptNames = new Set(keptEntities.map((e) => e.name));
      const keptRelationships = result.relationships.filter((r) => {
        if (r.confidence < this.minRel) {
          droppedRelationships++;
          return false;
        }
        if (!keptNames.has(r.sourceEntity) || !keptNames.has(r.targetEntity)) {
          droppedRelationships++;
          return false;
        }
        return true;
      });
      filtered.set(chunkId, {
        ...result,
        entities: keptEntities,
        relationships: keptRelationships,
      });
    }

    if (droppedEntities > 0 || droppedRelationships > 0) {
      log.info(
        {
          filePath: ctx.job.filePath,
          droppedEntities,
          droppedRelationships,
          minEntity: this.minEntity,
          minRel: this.minRel,
        },
        'confidence_filter.dropped'
      );
    }

    return filtered;
  }
}
