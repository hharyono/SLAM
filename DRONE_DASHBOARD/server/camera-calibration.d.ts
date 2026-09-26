export type CalibrationStatus = {
    active: boolean;
    samples: number;
    target: number;
    startedAt: number | null;
    message: string;
};
export declare class CameraCalibration {
    private rvHost;
    private setCalibrationVideo;
    private process?;
    private state;
    private readonly repositoryRoot;
    private readonly pending;
    private readonly output;
    constructor(rvHost: string, setCalibrationVideo: (active: boolean) => void);
    status(): {
        active: boolean;
        samples: number;
        target: number;
        startedAt: number | null;
        message: string;
    };
    private connectionOptions;
    private ssh;
    start(): Promise<{
        active: boolean;
        samples: number;
        target: number;
        startedAt: number | null;
        message: string;
    }>;
    private finishWorker;
    stop(): Promise<{
        active: boolean;
        samples: number;
        target: number;
        startedAt: number | null;
        message: string;
    }>;
}
