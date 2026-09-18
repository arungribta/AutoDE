import { PipelineEntity, PipelineSpec } from './types';

function renderEntity(entity: PipelineEntity): string {
  const lines: string[] = [`### ${entity.name}`, ''];
  lines.push(`**Source:** \`${entity.source.object}\` (${entity.source.type})`);
  lines.push(`**Target:** \`${entity.target.object}\` (${entity.target.materialization})`);
  if (entity.transforms.length > 0) {
    lines.push('', '**Transforms:**');
    for (const t of entity.transforms) {
      lines.push(`- \`${t.kind}\`${t.primitiveVersion ? ` (v${t.primitiveVersion})` : ''}`);
    }
  }
  if (entity.quality && entity.quality.rules.length > 0) {
    lines.push('', '**Quality rules:**');
    for (const rule of entity.quality.rules) lines.push(`- ${rule.description}`);
  }
  if (entity.governance && entity.governance.columns.length > 0) {
    lines.push('', '**Governance:**');
    for (const column of entity.governance.columns) lines.push(`- \`${column.column}\`: ${column.classification}`);
  }
  return lines.join('\n');
}

function renderLineageDiagram(spec: PipelineSpec): string {
  const lines: string[] = ['```mermaid', 'flowchart LR'];
  spec.entities.forEach((entity, index) => {
    lines.push(`  S${index}["${entity.source.object}"] --> T${index}["${entity.target.object}"]`);
  });
  lines.push('```');
  return lines.join('\n');
}

/**
 * Deterministically renders the Markdown design doc from a validated
 * Pipeline Spec — no LLM call. By the time the YAML exists and validates,
 * the Markdown is a readable projection of it: the same input always
 * produces the same output, so the two documents can never drift apart.
 */
export function generateDesignDoc(spec: PipelineSpec): string {
  const lines: string[] = [
    `# Pipeline Spec: ${spec.id} (v${spec.version})`,
    '',
    `Derived from Business Problem Specification \`${spec.derivedFromBpsId}\` v${spec.derivedFromBpsVersion}.`,
    '',
    `Target platform: **${spec.targetPlatform}**.`,
    '',
    '## Lineage',
    '',
    renderLineageDiagram(spec),
    '',
    '## Entities',
    ''
  ];
  for (const entity of spec.entities) {
    lines.push(renderEntity(entity), '');
  }
  return lines.join('\n');
}
