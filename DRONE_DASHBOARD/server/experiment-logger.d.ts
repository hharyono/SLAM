export type LogStatus = {
    active: boolean;
    sessionId: string | null;
    directory: string | null;
    startedAt: number | null;
};
export declare class ExperimentLogger {
    readonly root: string;
    private sessionId;
    private startedAt;
    constructor(root: string);
    status(): LogStatus;
    resume(sessionId: string): LogStatus;
    start(requested?: string): LogStatus;
    stop(): LogStatus;
    clear(): number;
    rx(_data: Buffer): void;
    tx(_data: Buffer): void;
    state(_data: unknown): void;
    frame(_data: unknown): void;
    landingLine(_line: string): void;
    event(_kind: string, _data?: unknown): void;
}
