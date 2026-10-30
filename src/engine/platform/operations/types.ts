/**
 * Platform operations (POP1; docs/specs/platform-operations.md): every
 * interaction with a platform is one declarative file, run by one
 * platform-neutral executor. These are the file's shapes.
 */

export const OPERATION_FORMAT_VERSION = 1;

/** How a parameter's value is bound into a template; never pasted in as text. */
export type ParamType = 'identifier' | 'identifier_list' | 'literal' | 'literal_list' | 'number' | 'boolean' | 'statement';

export interface OperationParam {
  name: string;
  type: ParamType;
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  /** number: the allowed range. */
  min?: number;
  max?: number;
}

/** How a result column is read: as text (default), a number, a yes/no flag, or JSON. */
export type ReturnType = 'string' | 'number' | 'yes_no' | 'boolean' | 'json';

export interface OperationReturn {
  name: string;
  /** The column the platform returns (matched without regard to case); default: `name`. */
  from?: string;
  as?: ReturnType;
  label?: string;
}

/** One platform's implementation, over one transport. */
export interface PlatformImpl {
  /** `sql`: a statement run on the connection (its CLI or API). */
  sql?: string;
  /** `cli`: an argument list (never a shell line); `{param}` in an argument is bound. */
  cli?: string[];
  /** `http`: a REST call (runs from POP5). */
  http?: { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: unknown; readOnly?: boolean; results?: string };
  /** `file`: files in a bound repository or folder (runs from POP5). */
  file?: { glob: string; parse: 'yaml' | 'json' | 'csv' };
  /** cli and http: how the output is read. */
  parse?: 'json' | 'table';
  /** The oldest platform version it works on (inclusive) and the first it doesn't. */
  since?: string;
  until?: string;
}

export interface OperationExample {
  params: Record<string, unknown>;
  /** What the platform returned, as rows. */
  rows: Array<Record<string, unknown>>;
  /** Which platform's implementation the example is for (default: the first). */
  platform?: string;
}

export interface PlatformOperation {
  formatVersion: number;
  id: string;
  title: string;
  description: string;
  /** `read` runs; `change` only becomes a runbook step a person approves. */
  kind: 'read' | 'change';
  /** `metadata`: object and column names only (shown whatever the sample-data setting); `data`: row values (gated by it). */
  content?: 'metadata' | 'data';
  /** The area it belongs to: estate, lineage, quality, governance, deployment, platform. */
  area: string;
  params: OperationParam[];
  returns: OperationReturn[];
  platforms: Record<string, PlatformImpl>;
  example?: OperationExample;
}

/** A capability a platform can serve, and how. */
export interface PlatformCapability {
  support: 'supported' | 'partly' | 'not_applicable';
  operations?: string[];
  /** What the role needs, in plain language. */
  privileges?: string;
  note?: string;
}

/** What a platform is and what AutoDE can do with it (§2.2). */
export interface PlatformDefinition {
  formatVersion: number;
  id: string;
  title: string;
  category: 'warehouse' | 'lakehouse' | 'semantic' | 'catalog' | 'orchestration' | 'bi';
  transports: Array<'sql' | 'cli' | 'http' | 'file'>;
  /** How AutoDE reaches it: the CLI (installed by the user, never bundled) and the API where the vendor has one. */
  access?: { cli?: { command: string; minVersion?: string; install?: string; credentialEnv?: string }; api?: { name: string } };
  /** The operation that reads the platform's version. */
  versionOperation?: string;
  /** How names and values are written on this platform. */
  dialect?: {
    /** Character that quotes an identifier that isn't plain (`"` or a backtick). */
    identifierQuote?: string;
    /** How the platform stores an unquoted name. */
    unquotedCase?: 'upper' | 'lower' | 'preserve';
    booleans?: [string, string];
    /** v0.54.1: the dialect fragments probes and reconciliation use. */
    fragments?: Record<string, string>;
  };
  /** What a read's `databases` parameter names here: databases (catalogs) by default, or schemas (Oracle's owners). */
  scopeLevel?: 'database' | 'schema';
  capabilities: Record<string, PlatformCapability>;
  /** Object kinds it has, so an unread kind is noticed (POP3). */
  objectKinds?: string[];
}

export type Origin = 'shipped' | 'team';

export interface Loaded<T> {
  item: T;
  origin: Origin;
  file: string;
  /** Content checksum (a team file's approval is for exactly this content). */
  checksum: string;
  /** A team file is a draft until a person approves it as a decision (kind platform_operation). */
  status: 'approved' | 'draft';
  approvedBy?: string;
  /** A team file that replaces a shipped one with the same id. */
  overrides?: boolean;
}
