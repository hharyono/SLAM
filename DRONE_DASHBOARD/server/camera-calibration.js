import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
const run = promisify(execFile);
export class CameraCalibration {
    rvHost;
    setCalibrationVideo;
    process;
    state = { active: false, samples: 0, target: 40, startedAt: null, message: 'Idle' };
    repositoryRoot = resolve(process.cwd(), '..');
    pending = resolve(this.repositoryRoot, 'LUCKFOX_CAM', 'Config', 'Camera.pending.yaml');
    output = resolve(this.repositoryRoot, 'LUCKFOX_CAM', 'Config', 'Camera.yaml');
    constructor(rvHost, setCalibrationVideo) {
        this.rvHost = rvHost;
        this.setCalibrationVideo = setCalibrationVideo;
    }
    status() { return { ...this.state }; }
    connectionOptions() { const askpass = process.env.RV_SSH_ASKPASS || resolve(this.repositoryRoot, 'LUCKFOX_CAM', '.deploy_askpass.sh'); return { timeout: 60_000, env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: process.env.DISPLAY || ':0' } }; }
    ssh(args) { return run('/usr/bin/ssh', ['-o', 'StrictHostKeyChecking=accept-new', `root@${this.rvHost}`, ...args], this.connectionOptions()); }
    async start() {
        if (this.state.active)
            return this.status();
        if (existsSync(this.pending))
            rmSync(this.pending);
        await this.ssh(['/usr/bin/precision_camera_calibration', 'start']);
        this.setCalibrationVideo(true);
        this.state = { active: true, samples: 0, target: 40, startedAt: Date.now(), message: 'Collecting ChArUco views' };
        const python = process.env.SLAM_PYTHON || '/home/haryono/.local/share/mamba/envs/SLAM/bin/python';
        const script = resolve(this.repositoryRoot, 'LUCKFOX_CAM', 'tools', 'calibrate_charuco.py');
        const child = spawn(python, [script, '--device', `rtsp://${this.rvHost}:8554/cal`, '--output', this.pending, '--width', '1280', '--height', '720', '--squares-x', '7', '--squares-y', '5', '--square-mm', '30', '--marker-mm', '22', '--samples', '40', '--headless', '--wait-for-stop'], { env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] });
        child.stdin.end();
        this.process = child;
        child.stdout.on('data', data => { for (const line of data.toString().split('\n')) {
            const match = /SAMPLE (\d+)\/(\d+)/.exec(line);
            if (match) {
                this.state.samples = Number(match[1]);
                this.state.target = Number(match[2]);
                this.state.message = `Collected ${match[1]}/${match[2]} views`;
            }
        } });
        child.stderr.on('data', data => { const message = data.toString().trim(); if (message)
            this.state.message = message.slice(-300); });
        child.on('close', code => { if (this.process === child)
            this.process = undefined; if (code && this.state.active)
            this.state.message = `Calibration worker exited (${code})`; });
        return this.status();
    }
    async finishWorker() { const child = this.process; if (!child)
        return; if (child.exitCode === null)
        child.kill('SIGINT'); await new Promise(resolveDone => { const timer = setTimeout(() => { if (child.exitCode === null)
        child.kill('SIGKILL'); resolveDone(); }, 15_000); child.once('close', () => { clearTimeout(timer); resolveDone(); }); }); this.process = undefined; }
    async stop() {
        if (!this.state.active)
            return this.status();
        this.state.message = 'Finalizing calibration';
        await this.finishWorker();
        // Stop the calibration stream without restarting the primary camera yet;
        // apply/landing below guarantees it is restarted with either new or old YAML.
        await this.ssh(['/usr/bin/precision_camera_calibration', 'finalize']);
        try {
            if (!existsSync(this.pending))
                throw new Error(`Calibration rejected: only ${this.state.samples} usable views (minimum 12)`);
            copyFileSync(this.pending, this.output);
            await run('/usr/bin/scp', ['-q', '-o', 'StrictHostKeyChecking=accept-new', this.output, `root@${this.rvHost}:/tmp/Camera.yaml.new`], this.connectionOptions());
            await this.ssh(['/usr/bin/precision_camera_calibration', 'apply']);
            this.state = { ...this.state, active: false, startedAt: null, message: `Saved Camera.yaml from ${this.state.samples} views` };
        }
        catch (error) {
            await this.ssh(['/usr/bin/precision_camera_calibration', 'landing']).catch(() => { });
            this.state = { ...this.state, active: false, startedAt: null, message: error instanceof Error ? error.message : String(error) };
            throw error;
        }
        finally {
            this.setCalibrationVideo(false);
            if (existsSync(this.pending))
                rmSync(this.pending);
        }
        return this.status();
    }
}
