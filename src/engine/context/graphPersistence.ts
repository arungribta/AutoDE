import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GraphSnapshotFile {
  nodes: unknown[];
  edges: unknown[];
  compiledAt: string;
}

/** Writes a JSON file atomically (temp file + rename) to prevent corruption. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Reads the compiled graph snapshot from `derived/graph.json`. */
export function readGraphSnapshot(filePath: string): GraphSnapshotFile | null {
  return readJsonFile<GraphSnapshotFile>(filePath);
}

/** Persists the compiled graph snapshot atomically to `derived/graph.json`. */
export function writeGraphSnapshot(filePath: string, snapshot: GraphSnapshotFile): void {
  writeJsonAtomic(filePath, snapshot);
}
