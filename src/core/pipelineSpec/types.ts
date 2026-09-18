import { PrimitiveKind } from '../transforms/types';

/**
 * The Pipeline Spec (Phase 2B-i) — a strictly-validated, machine-compilable
 * YAML artifact generated from an approved Business Problem Specification
 * (a BRD, not itself compile-ready). `PIPELINE_SPEC_SCHEMA` (schema.ts)
 * enforces `additionalProperties: false` at every nesting level here — a
 * typo becomes a hard validation error immediately, this codebase's
 * analogue of Pydantic's `extra="forbid"`.
 */

/** Bumped only when the Pipeline Spec's own shape changes incompatibly — separate from a document's own `version`. */
export const CURRENT_PIPELINE_SPEC_VERSION = 1;

export type PipelineSpecStatus = 'draft' | 'approved';

export interface PipelineTransformStep {
  kind: PrimitiveKind;
  params: Record<string, unknown>;
  /** Pins a specific Tier-2 primitive version (Phase 2B-iv) — omitted means "latest published". */
  primitiveVersion?: number;
}

export interface PipelineEntitySource {
  object: string;
  type: 'table' | 'view' | 'file' | 'stream' | 'api' | 'other';
}

export interface PipelineEntityTarget {
  object: string;
  materialization: 'table' | 'view';
}

export interface PipelineQualityRule {
  description: string;
}

export type PipelineGovernanceClassification = 'none' | 'pii' | 'sensitive-pii' | 'confidential';

export interface PipelineGovernanceColumn {
  column: string;
  classification: PipelineGovernanceClassification;
}

export interface PipelineEntity {
  name: string;
  source: PipelineEntitySource;
  transforms: PipelineTransformStep[];
  target: PipelineEntityTarget;
  /** Forward slot — populated by Phase 6 (DQ-as-Code). */
  quality?: { rules: PipelineQualityRule[] };
  /** Forward slot — populated by Phase 6 (Governance). */
  governance?: { columns: PipelineGovernanceColumn[] };
}

export interface PipelineSpec {
  specVersion: number;
  id: string;
  version: number;
  status: PipelineSpecStatus;
  derivedFromBpsId: string;
  derivedFromBpsVersion: number;
  targetPlatform: string;
  entities: PipelineEntity[];
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
}
