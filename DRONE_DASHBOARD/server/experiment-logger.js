import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
const safe = (value) => value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const isChild = (root, target) => { const path = relative(root, target); return path !== '' && !path.startsWith('..') && !isAbsolute(path); };
// Recording is intentionally performed only on the RV. This class tracks UI
// state and manages already-downloaded session folders on the development PC.
export class ExperimentLogger {
    root;
    sessionId = null;
    startedAt = null;
    constructor(root) { this.root = resolve(root); mkdirSync(this.root, { recursive: true }); }
    status() { return { active: this.sessionId !== null, sessionId: this.sessionId, directory: this.sessionId ? `/root/logs/precision-landing-sessions/${this.sessionId}` : null, startedAt: this.startedAt }; }
    resume(sessionId) { this.sessionId = safe(sessionId); this.startedAt = Date.now(); return this.status(); }
    start(requested) { if (this.sessionId)
        return this.status(); const base = safe(requested || `flight-${stamp()}`) || `flight-${stamp()}`; let id = base, n = 2; while (existsSync(resolve(this.root, id)))
        id = `${base}-${n++}`; this.sessionId = id; this.startedAt = Date.now(); return this.status(); }
    stop() { this.sessionId = null; this.startedAt = null; return this.status(); }
    clear() { if (this.sessionId)
        throw new Error('stop logging before clearing log files'); const entries = readdirSync(this.root); for (const entry of entries) {
        const target = resolve(this.root, entry);
        if (!isChild(this.root, target))
            throw new Error('invalid log target');
        rmSync(target, { recursive: true, force: true });
    } return entries.length; }
    rx(_data) { }
    tx(_data) { }
    state(_data) { }
    frame(_data) { }
    landingLine(_line) { }
    event(_kind, _data = {}) { }
}
