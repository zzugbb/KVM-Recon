export {};

declare global {
  interface Window {
    kvmRecon?: {
      appName: string;
      startCapture(target: {
        host: string;
        port: number;
        scheme: 'http' | 'https';
      }): Promise<{
        jobId: string;
        timeline: unknown;
        network: unknown;
        networkArtifacts: Array<{
          path: string;
          content: string;
        }>;
      }>;
    };
  }
}
