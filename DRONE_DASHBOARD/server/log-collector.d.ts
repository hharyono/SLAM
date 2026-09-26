export declare function remoteLogSession(rvHost: string): Promise<string | null>;
export declare function startRemoteLog(sessionId: string, rvHost: string): Promise<void>;
export declare function stopAndCollectRemoteLog(sessionId: string, localRoot: string, rvHost: string): Promise<{
    ok: boolean;
    directory: string;
}>;
export declare function clearRemoteLogs(rvHost: string): Promise<void>;
