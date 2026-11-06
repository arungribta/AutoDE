import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Whether a path a model or an agent named stays inside a folder, with links followed: `docs/ref -> ~/.ssh` looks
 * inside and isn't. The nearest part of the path that exists decides, so a file about to be written is checked too.
 * Returns the resolved path, or `undefined` when it is outside.
 */
export function insideFolder(root: string, requested: string): string | undefined {
  const base = path.resolve(root);
  const full = path.resolve(base, requested || '.');
  const outside = (rel: string) => rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (outside(path.relative(base, full))) return undefined;
  let real: string;
  try { real = fs.realpathSync(base); } catch { return full; }
  let existing = full;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return outside(path.relative(real, path.join(fs.realpathSync(existing), path.relative(existing, full)))) ? undefined : full;
}
