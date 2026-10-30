import { SqlDialect } from './types';

/**
 * The statement that (re)creates a deliverable's view or table from a query
 * (v0.55.2). `CREATE OR REPLACE` everywhere it exists; Redshift has it for
 * views but not tables, so a table is dropped and created again.
 */
export function createOrReplace(kind: 'TABLE' | 'VIEW', name: string, dialect: SqlDialect): string {
  if (dialect === 'redshift' && kind === 'TABLE') return `DROP TABLE IF EXISTS ${name};\nCREATE TABLE ${name} AS`;
  return `CREATE OR REPLACE ${kind} ${name} AS`;
}
