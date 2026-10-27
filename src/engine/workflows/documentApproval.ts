import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseYaml, stringifyYaml } from '../context/Yaml';
import { parseBusinessProblemSpec, parseMappingContext, parsePipelineSpecDocument, readProblemDocument, serializeMappingContext, writeBusinessProblemSpec, writePipelineSpec } from '../documents/problemDocuments';
import { validatePipelineSpec } from '../pipelineSpec/validator';
import { AssertionLedger } from '../context/ledger';
import { layoutPath } from '../workspaceLayout';
import { governanceFacts, governanceGaps, unmaskedSensitive } from '../governance/governance';
import { problemMode, recordWarnedCheck } from '../documents/problemMode';
import { StageKind } from './stageKinds';
import { readWorkflow } from './instance';
import { Actor, appendEvent } from './events';
import { RuntimeContext, WorkflowError, workflowNeedsSources } from './runtime';

/**
 * Approving a stage whose output is a document with its own approval
 * (v0.45.1): the specification, the target and source contexts, the mapping
 * and the Pipeline Spec. One implementation for the Workflow view and
 * `autode workflow approve <stage>`; a person's act only, so no MCP tool
 * calls it. The document is checked first — the same checks the panel's own
 * approve buttons make — and the runtime then reads the stage as done.
 */

const FILES: Partial<Record<StageKind, string[]>> = {
  'specify': ['spec', 'business-problem.yaml'],
  'target-context': ['context', 'target-context.yaml'],
  'source-assessment': ['context', 'source-context.yaml'],
  'mapping': ['context', 'mapping-context.yaml'],
  'build': ['spec', 'pipeline.yaml']
};

const NAMES: Partial<Record<StageKind, string>> = {
  'specify': 'specification', 'target-context': 'target context', 'source-assessment': 'source context', 'mapping': 'mapping', 'build': 'Pipeline Spec'
};

export function isDocumentStage(kind: StageKind): boolean {
  return FILES[kind] !== undefined;
}

export function stageDocumentFile(problemRoot: string, kind: StageKind): string | undefined {
  const rel = FILES[kind];
  return rel ? path.join(problemRoot, ...rel) : undefined;
}

/** What stops the stage's document from being approved now (empty: it can be). In exploration mode, checks only warn. */
export function documentApprovalProblems(problemRoot: string, kind: StageKind): string[] {
  return documentApprovalCheck(problemRoot, kind).errors;
}

/**
 * The checks on a stage's document, split by mode (C4c, §7.4): in governed
 * mode every failed check refuses; in exploration mode the checks that guard
 * consistency and governance (another specification version, a source
 * context with no source, an unmasked sensitive column) only warn. A
 * document that isn't there or can't be read always refuses.
 */
export function documentApprovalCheck(problemRoot: string, kind: StageKind): { errors: string[]; warnings: string[] } {
  const { hard, soft } = documentChecks(problemRoot, kind);
  return problemMode(problemRoot) === 'exploration' ? { errors: hard, warnings: soft } : { errors: [...hard, ...soft], warnings: [] };
}

function documentChecks(problemRoot: string, kind: StageKind): { hard: string[]; soft: string[] } {
  const all = documentProblems(problemRoot, kind);
  return { hard: all.filter((p) => !p.soft).map((p) => p.text), soft: all.filter((p) => p.soft).map((p) => p.text) };
}

function documentProblems(problemRoot: string, kind: StageKind): Array<{ text: string; soft?: boolean }> {
  const hard = (texts: string[]) => texts.map((text) => ({ text }));
  const soft = (texts: string[]) => texts.map((text) => ({ text, soft: true }));
  const name = NAMES[kind] ?? kind;
  const file = stageDocumentFile(problemRoot, kind);
  if (!file) return hard([`${kind} stages have no document of their own.`]);
  if (!fs.existsSync(file)) return hard([`There is no ${name} yet.`]);
  const text = fs.readFileSync(file, 'utf8');
  const specText = readProblemDocument(problemRoot, 'spec');
  const spec = specText ? parseBusinessProblemSpec(specText) : undefined;
  const sameSpec = (d: { specId?: unknown; specVersion?: unknown }) => !spec || (d.specId === spec.id && Number(d.specVersion) === spec.version);
  switch (kind) {
    case 'specify': {
      const s = parseBusinessProblemSpec(text);
      return s.problemStatement?.trim() ? [] : hard(['The specification has no problem statement.']);
    }
    case 'target-context': case 'source-assessment': {
      const d = parseYaml(text) as Record<string, unknown>;
      const errors = sameSpec(d) ? [] : soft([`The ${name} was built for another version of the specification: rebuild it first.`]);
      const w = readWorkflow(problemRoot);
      if (kind === 'source-assessment' && w && workflowNeedsSources(w) && (d.status === 'not_applicable' || !Array.isArray(d.sources) || !d.sources.length)) {
        errors.push(...soft(['This workflow maps sources, so the source context needs at least one source: bring the source into the estate (Ingest File, `autode estate ingest`), then pick it (Pick from the Estate, `autode context sources --system <id>`).']));
      }
      return errors;
    }
    case 'mapping': {
      const m = parseMappingContext(text);
      const errors: Array<{ text: string; soft?: boolean }> = [];
      if (!m.mappings.length) errors.push(...hard(['The mapping has no entity mappings yet.']));
      if (!sameSpec(m)) errors.push(...soft(['The mapping was built for another version of the specification.']));
      return errors;
    }
    case 'build': {
      const p = parsePipelineSpecDocument(text);
      const v = validatePipelineSpec(p);
      // GOV: confirmed sensitive-pii facts about the columns it reads must be in its governance blocks.
      const ledger = new AssertionLedger(layoutPath(path.resolve(problemRoot, '..', '..', '..'), 'ledger'));
      ledger.loadSync();
      const gaps = governanceGaps(p, governanceFacts(ledger.assertions())).errors;
      const masking = new Set(v.valid ? [] : unmaskedSensitive(p));
      const label = (e: string) => `Pipeline Spec: ${e}`;
      return [...(v.valid ? [] : v.errors).map((e) => ({ text: label(e), soft: masking.has(e) })), ...soft(gaps.map(label))];
    }
    default: return [];
  }
}

export function approveStageDocument(ctx: RuntimeContext, stageId: string, who: Extract<Actor, { kind: 'person' }>, channel: string, now: Date = new Date()): { stage: string; file: string; message: string } {
  const w = readWorkflow(ctx.problemRoot);
  const s = w?.stages.find((x) => x.id === stageId);
  if (!w || !s || !s.included) throw new WorkflowError('NOT_FOUND', `No stage "${stageId}".`);
  const file = stageDocumentFile(ctx.problemRoot, s.kind);
  if (!file) throw new WorkflowError('NOT_ALLOWED', `${stageId} is approved through its gate, not a document.`);
  const check = documentApprovalCheck(ctx.problemRoot, s.kind);
  if (check.errors.length) throw new WorkflowError('CHECK_FAILED', check.errors.join(' '));
  const at = now.toISOString();
  // Exploration mode: what only warned is kept for hardening.
  for (const w of check.warnings) recordWarnedCheck(ctx.problemRoot, { at, check: `${NAMES[s.kind]} approval`, stage: s.id, detail: w });
  const text = fs.readFileSync(file, 'utf8');
  switch (s.kind) {
    case 'specify':
      writeBusinessProblemSpec(ctx.problemRoot, { ...parseBusinessProblemSpec(text), status: 'approved', problemStatementApproved: true, approvedAt: at, approvedBy: who.name, updatedAt: at } as ReturnType<typeof parseBusinessProblemSpec>);
      break;
    case 'build':
      writePipelineSpec(ctx.problemRoot, { ...parsePipelineSpecDocument(text), status: 'approved', approvedAt: at, approvedBy: who.name, updatedAt: at } as ReturnType<typeof parsePipelineSpecDocument>);
      break;
    case 'mapping':
      fs.writeFileSync(file, serializeMappingContext({ ...parseMappingContext(text), status: 'approved', approvedAt: at, approvedBy: who.name } as ReturnType<typeof parseMappingContext>));
      break;
    default: {
      const header = s.kind === 'target-context' ? '# AutoDE Target Context\n' : '# AutoDE Source Context\n';
      fs.writeFileSync(file, header + stringifyYaml({ ...(parseYaml(text) as Record<string, unknown>), status: 'approved', approvedAt: at, approvedBy: who.name }));
    }
  }
  appendEvent(ctx.problemRoot, { at, type: 'approved', stage: s.id, actor: who, channel, files: [path.relative(ctx.workspaceRoot, file).split(path.sep).join('/')] });
  return { stage: s.id, file, message: `${NAMES[s.kind]} approved by ${who.name}: ${stageId} is done.${check.warnings.length ? ` Exploration mode: ${check.warnings.length} check(s) only warned (${check.warnings.join(' ')}); they are listed for hardening.` : ''}` };
}
