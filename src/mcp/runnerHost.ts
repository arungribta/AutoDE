import { spawn } from 'node:child_process';
import { PlatformSession } from './platform';
import { RunnerHost } from '../engine/runner/run';
import { checkReadOnlySql, stripTrailingSemicolon } from '../engine/platform/sqlGuard';

/**
 * The runner's way to the platforms (v0.45.6): SQL through the same
 * connectors as everything else (a session that may write, created only for an
 * approved runbook's run), commands through the user's own CLI with no shell.
 * Read steps report row counts, never row values. No vscode import, so the
 * terminal runner (backlog) uses the same host.
 */
export function createRunnerHost(options: { workspaceRoot: string; allowCli: boolean; driversRoot?: string; log: (line: string) => void; session?: PlatformSession }): { host: RunnerHost; dispose: () => void } {
  const session = options.session ?? new PlatformSession({ workspaceRoot: options.workspaceRoot, allowWrite: true, allowCli: options.allowCli, driversRoot: options.driversRoot, log: options.log });
  const host: RunnerHost = {
    async sql(connectionId, sql, mode) {
      const entry = session.entry(connectionId);
      const body = stripTrailingSemicolon(sql);
      if (mode === 'write') return session.executeApprovedChange(connectionId, body);
      const manager = await session.connect(entry);
      if (mode === 'explain') {
        const r = entry.platform === 'oracle'
          ? (await manager.executeQuery(`EXPLAIN PLAN FOR ${body}`), { rowCount: 1 })
          : await manager.executeQuery(`${entry.platform === 'snowflake' ? 'EXPLAIN USING TEXT' : 'EXPLAIN'} ${body}`, { maxRows: 50 });
        return `The platform compiled it (plan: ${r.rowCount} line(s)).`;
      }
      const check = checkReadOnlySql(body);
      if (!check.ok) throw new Error(check.reason);
      const r = await manager.executeQuery(body, { maxRows: 100 });
      return `${r.rowCount} row(s).`;
    },
    cli(argv, cwd, timeoutMs) {
      return new Promise((resolve) => {
        let stdout = ''; let stderr = '';
        const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, windowsHide: true, env: process.env });
        const timer = setTimeout(() => { stderr += `\nStopped after ${Math.round(timeoutMs / 1000)} s.`; child.kill(); }, timeoutMs);
        child.stdout.on('data', (d) => { if (stdout.length < 200_000) stdout += String(d); });
        child.stderr.on('data', (d) => { if (stderr.length < 200_000) stderr += String(d); });
        child.on('error', (err) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
    }
  };
  return { host, dispose: () => session.dispose() };
}
