export interface TaskModelUsageCounters {
  requestCount: number;
  successRequestCount: number;
  failedRequestCount: number;
  unknownTokenRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface TaskModelUsageStage extends TaskModelUsageCounters {
  stage: string;
}

export interface TaskModelUsageSummary extends TaskModelUsageCounters {
  recorded: true;
  taskId: string;
  taskType: string;
  stages: TaskModelUsageStage[];
  updatedAt: string;
}
