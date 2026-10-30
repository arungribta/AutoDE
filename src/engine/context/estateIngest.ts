import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextFileManager } from './contextFileManager';
import { GraphManager } from './graphManager';
import { detectFileFormat, parseFile } from './fileIngestion';
import { ConnectionManager } from '../platform/ConnectionManager';

/**
 * Bringing an estate in without VS Code (parity step 1a, v0.43.2): a DDL, CSV
 * or JSON file, or a connection's schemas, into the catalog, the working set
 * and the ledger — through the same `ContextFileManager.ingestParsed()` the
 * panel's *Ingest File* and Source Assessment use. What is recorded is
 * observed metadata (what the source or file says), never inferred knowledge,
 * which is why it needs no decision (roadmap decision log 2026-10-20).
 */

/** The workspace's context layer, loaded from disk (no watcher: the CLI and the MCP server read per call). */
export async function openContext(workspaceRoot: string, log: (msg: string) => void = () => undefined): Promise<ContextFileManager> {
  const cfm = new ContextFileManager(workspaceRoot, new GraphManager(), log);
  await cfm.initialize();
  return cfm;
}

export interface IngestResult {
  source: string;
  system: string;
  environment: string;
  tables: number;
  columns: number;
  /** Tables now in the catalog from this source, and how many entered the working set. */
  catalogued: number;
  promoted: number;
  warnings: string[];
}

/** One file. With `system`, the file is bound to it in `estate.yaml` first; otherwise the estate decides (a system named after the file when unbound). */
export async function ingestFile(cfm: ContextFileManager, filePath: string, options: { system?: string; environment?: string } = {}): Promise<IngestResult> {
  const format = detectFileFormat(filePath);
  if (!format) throw new Error(`${path.basename(filePath)}: unsupported file type (supported: .sql, .ddl, .csv, .json).`);
  if (options.system) cfm.bindToSystem({ file: path.basename(filePath), system: options.system, ...(options.environment ? { environment: options.environment } : {}) });
  const identity = cfm.resolveFile(filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFile(content, filePath, { system: identity.system, environment: identity.environment });
  if (parsed.tableCount === 0) throw new Error(`No tables found in ${path.basename(filePath)}${parsed.warnings.length ? `: ${parsed.warnings.join(' ')}` : '.'}`);
  const r = await cfm.ingestParsed(parsed.nodes, parsed.edges);
  return { source: filePath, system: identity.system ?? '', environment: identity.environment ?? '', tables: parsed.tableCount, columns: parsed.columnCount, catalogued: r.catalogued, promoted: r.promoted, warnings: parsed.warnings };
}

/**
 * A connected platform's schemas (structure; with `profile`, sampled counts —
 * row values only where the connection allows sample data). `schemas` are
 * `DATABASE.SCHEMA` (or `SCHEMA`); omitted, the estate binding's schemas apply.
 */
export async function ingestConnection(cfm: ContextFileManager, manager: ConnectionManager, connectionId: string, options: { schemas?: string[]; system?: string; environment?: string; profile?: boolean } = {}): Promise<IngestResult> {
  if (options.system) cfm.bindToSystem({ connection: connectionId, system: options.system, ...(options.environment ? { environment: options.environment } : {}), ...(options.schemas?.length ? { schemas: options.schemas } : {}) });
  manager.setEstateResolver((id) => cfm.resolveConnection(id));
  const resolved = cfm.resolveConnection(connectionId);
  const schemas = options.schemas?.length ? options.schemas : resolved.schemas;
  if (!schemas?.length) throw new Error(`Name the schemas to bring in (DATABASE.SCHEMA), or bind them to ${connectionId} in .autode/knowledge/estate.yaml.`);
  const snapshot = await manager.extractMetadata({ schemaFilter: schemas, includeProfiling: options.profile === true });
  const g = manager.snapshotGraph(snapshot);
  const columns = g.nodes.filter((n) => n.type === 'column').length;
  const r = await cfm.ingestParsed(g.nodes, g.edges);
  return { source: `${connectionId} (${schemas.join(', ')})`, system: resolved.identity.system ?? '', environment: resolved.identity.environment ?? '', tables: snapshot.tables.length + snapshot.views.length, columns, catalogued: r.catalogued, promoted: r.promoted, warnings: (snapshot.gaps ?? []).map((g) => `Not read: ${g}`) };
}
