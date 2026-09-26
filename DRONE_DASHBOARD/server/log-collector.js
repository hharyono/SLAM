import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
const askpass = () => process.env.RV_SSH_ASKPASS || resolve(process.cwd(), '..', 'LUCKFOX_CAM', '.deploy_askpass.sh');
const options = () => ({ timeout: 60_000, env: { ...process.env, SSH_ASKPASS: askpass(), SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0' } });
async function ssh(rvHost, args) { if (!existsSync(askpass()))
    throw new Error(`SSH askpass not found: ${askpass()}`); return run('/usr/bin/ssh', ['-o', 'StrictHostKeyChecking=accept-new', `root@${rvHost}`, ...args], options()); }
export async function remoteLogSession(rvHost) { const { stdout } = await ssh(rvHost, ['/usr/bin/precision_landing_log', 'status']); const value = stdout.trim(); if (value === 'inactive' || !value)
    return null; const prefix = '/root/logs/precision-landing-sessions/'; if (!value.startsWith(prefix))
    throw new Error(`invalid remote logging status: ${value}`); const sessionId = value.slice(prefix.length); if (!/^[A-Za-z0-9._-]+$/.test(sessionId))
    throw new Error(`invalid remote session id: ${sessionId}`); return sessionId; }
export async function startRemoteLog(sessionId, rvHost) { await ssh(rvHost, ['/usr/bin/precision_landing_log', 'start', sessionId]); }
export async function stopAndCollectRemoteLog(sessionId, localRoot, rvHost) { await ssh(rvHost, ['/usr/bin/precision_landing_log', 'stop']); await run('/usr/bin/scp', ['-q', '-r', '-o', 'StrictHostKeyChecking=accept-new', `root@${rvHost}:/root/logs/precision-landing-sessions/${sessionId}`, localRoot], options()); return { ok: true, directory: resolve(localRoot, sessionId) }; }
export async function clearRemoteLogs(rvHost) { await ssh(rvHost, ['/usr/bin/precision_landing_log', 'clear']); }
