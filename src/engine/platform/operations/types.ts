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

/** How a REST read's pages are followed (POP5): declared here, looped by the executor. */
export interface HttpPaging {
  style: 'offset' | 'page' | 'cursor' | 'link';
  /** offset, page, cursor: the query parameter that says where to read from. */
  param?: string;
  /** offset, page: the query parameter for the page size, and that size (default 100). */
  sizeParam?: string;
  size?: number;
  /** offset, page: the first value (default 0 for offset, 1 for page). */
  start?: number;
  /** cursor, link: the path in the response to the next cursor or link; absent or empty ends the read. */
  next?: string;
  /** offset, page: the path to the total count, when the API gives one. */
  total?: string;
}

export interface HttpImpl {
  method: 'GET' | 'POST';
  /** After the connection's base URL; `{param}` is encoded as one path segment. */
  path: string;
  query?: Record<string, string>;
  /** A JSON template: `"{param}"` alone keeps the value's type; an optional parameter with no value drops the key. */
  body?: unknown;
  /** A POST that changes nothing (a search). */
  readOnly?: boolean;
  /** The path to the rows in the response (`results`, `$.data.items`); absent: the response is the rows. */
  results?: string;
  paging?: HttpPaging;
}

export interface FileImpl {
  /** Relative to the connection's folder: `*`, `**`, `?`, `{a,b}`; `{param}` is bound. */
  glob: string;
  parse: 'yaml' | 'json' | 'csv';
  /** yaml, json: the path to the rows in each file; absent: one row per file. */
  results?: string;
}

/** One platform's implementation, over one transport. */
export interface PlatformImpl {
  /** `sql`: a statement run on the connection (its CLI or API). */
  sql?: string;
  /** `cli`: an argument list (never a shell line); `{param}` in an argument is bound. */
  cli?: string[];
  /** `http`: a REST call on the connection's base URL (POP5). */
  http?: HttpImpl;
  /** `file`: files in the connection's bound folder (POP5). */
  file?: FileImpl;
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

/**
 * POP5b: one platform's implementation of an operation another file holds, so adding a system leaves the shipped
 * operation (and every other platform's statement in it) as AutoDE ships it.
 */
export interface ImplementationFile {
  formatVersion: number;
  /** The operation it adds to. */
  implements: string;
  platform: string;
  implementation: PlatformImpl;
  example?: Pick<OperationExample, 'params' | 'rows'>;
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
  /** The change operations that grant them, in order (POP4b: Request access drafts a runbook from these). */
  grants?: string[];
  note?: string;
}

/**
 * v0.55.0: how a statement reaches a platform that has only a CLI (no adapter class). Each call is an argument
 * list after the CLI's command; `{sql}` and `{id}` are filled in, and the connection's arguments are added
 * (its fields' `cliArg`). `sync`: one call returns the rows. `async`: submit, poll until finished, fetch pages.
 */
export interface CliStatement {
  mode: 'sync' | 'async';
  /** sync: the call, and where its rows are (a dotted path; absent = the output is the rows). */
  run?: { args: string[]; rows?: string };
  /** async: the call that submits the statement, and where its id is. */
  submit?: { args: string[]; id: string };
  /** async: the call that reads its state; which states end it; where the error and "has a result" are. */
  poll?: { args: string[]; status: string; finished: string[]; failed: string[]; error?: string; hasResult?: string };
  /** async: the call that reads a page of the result; where the rows, column names and next page's token are. */
  fetch?: { args: string[]; rows: string; columns?: string; columnName?: string; nextToken?: string; nextTokenArg?: string; cells?: 'plain' | 'typed' };
  /** async: the call that cancels it (best effort, on a timeout or a stop). */
  cancel?: { args: string[] };
}

/** v0.55.0: one field of a connection to the platform, as its card, `connections.yaml` and the CLI ask for it. */
export interface ConnectionField {
  name: string;
  label: string;
  description?: string;
  required?: boolean;
  /** Differs per engineer: kept in the personal file. */
  personal?: boolean;
  /** A credential: never in a file; from VS Code's secret storage or the environment. */
  secret?: boolean;
  /** Passed to the CLI as this argument (a non-secret field). */
  cliArg?: string;
  /** `every`: on every CLI call (region, profile); `submit` (default): only where the statement is submitted. */
  cliScope?: 'every' | 'submit';
  /** Passed to the CLI in this environment variable (a secret's only way in). */
  env?: string;
}

/** v0.55.0: what a connection to the platform is made of, for a platform without a card written for it. */
export interface ConnectionDefinition {
  fields: ConnectionField[];
  /** The fields whose first present value names the connection (`redshift:<it>`). */
  idFields?: string[];
  /** Groups of fields of which exactly one must be given. */
  exactlyOne?: string[][];
  /** The ways to sign in, each with the fields it needs. */
  authModes?: Array<{ mode: string; label: string; requires?: string[]; note?: string }>;
  /** The field a `cli` reference (the CLI's own profile) fills. */
  cliProfileField?: string;
  /** Roles it can play; default both. */
  roles?: Array<'source' | 'target'>;
  /** Shown on a Target card while building for the platform isn't supported yet. */
  targetNote?: string;
}

/** One of the fixed sign-in methods for an API (POP5; a new one is code, §6.5), and the connection fields it uses. */
export interface ApiAuth {
  method: 'bearer' | 'basic' | 'oauth_client_credentials';
  /** bearer: the secret field holding the token. */
  tokenField?: string;
  /** bearer: the header it goes in (default Authorization) and the word before it (default Bearer; empty for an API key). */
  header?: string;
  scheme?: string;
  /** basic. */
  usernameField?: string;
  passwordField?: string;
  /** oauth_client_credentials: the fields, and the token endpoint on the connection's own address. */
  clientIdField?: string;
  clientSecretField?: string;
  tokenPath?: string;
  scope?: string;
}

/** The vendor's API, as `http` operations reach it. */
export interface ApiAccess {
  name: string;
  /** POP5: the connection field holding the base URL. */
  baseUrlField?: string;
  /** POP5: the ways to sign in; the first whose fields the connection has is used. */
  auth?: ApiAuth[];
  /** POP5: headers sent on every call (never a secret). */
  headers?: Record<string, string>;
}

/** What a platform is and what AutoDE can do with it (§2.2). */
export interface PlatformDefinition {
  formatVersion: number;
  id: string;
  title: string;
  category: 'warehouse' | 'lakehouse' | 'semantic' | 'catalog' | 'orchestration' | 'bi';
  transports: Array<'sql' | 'cli' | 'http' | 'file'>;
  /** How AutoDE reaches it: the CLI (installed by the user, never bundled) and the API where the vendor has one. */
  access?: {
    cli?: {
      command: string; minVersion?: string; install?: string; credentialEnv?: string;
      /** v0.55.0: the executable's name per OS, when it differs from `command` (Windows: `aws.exe`). */
      binary?: { win32?: string; default?: string };
      /** v0.55.0: folders the vendor's installer uses, looked in when it isn't on PATH. */
      wellKnownDirs?: { win32?: string[]; default?: string[] };
      versionArgs?: string[];
      /** v0.55.0: environment variables set on every call (no secrets: for example turning the CLI's pager off). */
      env?: Record<string, string>;
      /** v0.55.0: the arguments that list the CLI's own profiles, one per line. */
      listProfiles?: string[];
      /** v0.55.0: how a statement runs through the CLI, for a platform without an adapter class. */
      statement?: CliStatement;
      /** CR1: the sub-commands that only read (`[tables, list]`): a `cli` read must start with one of them. */
      readCommands?: string[][];
      /** POP5: what the CLI prints when it is waiting on a browser sign-in (regular expressions); AutoDE stops it and says so. */
      browserSignIn?: string[];
    };
    api?: ApiAccess;
    /** POP5: `file` operations read the folder this connection field names (it may be a Git checkout). */
    file?: { rootField: string };
  };
  /** v0.55.0: the connection's fields and sign-in, for a platform without a card written for it. */
  connection?: ConnectionDefinition;
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
    /** POP4a: the SQL dialect deliverables compile to here (a warehouse or lakehouse that is a target). */
    compile?: 'snowflake' | 'spark_sql' | 'google_sql' | 'postgres' | 'tsql' | 'redshift' | 'ansi';
  };
  /** What a read's `databases` parameter names here: databases (catalogs) by default, or schemas (Oracle's owners). */
  scopeLevel?: 'database' | 'schema';
  capabilities: Record<string, PlatformCapability>;
  /** Object kinds it has, so an unread kind is noticed (POP3). */
  objectKinds?: string[];
  /** POP3: the platform's own wording of errors, so drift is told from other failures. */
  errors?: { missingObject?: string[] };
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
  /** POP5b: platforms whose implementation comes from a team's implementation file. */
  teamImplementations?: string[];
}
