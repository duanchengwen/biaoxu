export interface PresentationBidAnalysisTaskDefinition {
  id: string;
}

export interface PresentationBidAnalysisResult {
  status?: string;
  content?: string;
}

export function areBidAnalysisTasksReady(
  tasks: Record<string, PresentationBidAnalysisResult | undefined>,
  taskDefinitions: PresentationBidAnalysisTaskDefinition[],
): boolean;

export interface PageAssistantState {
  targetPages: number;
  minimumPages: number;
  maximumPages: number;
  measuredPages: number;
  requirementText: string;
  accepted: boolean;
  measurementLabel: string;
}

export function resolvePageAssistantState(
  contentStats: any,
  snapshot?: { mode?: string; targetPages?: number; minimumPages?: number; maximumPages?: number },
): PageAssistantState;

export interface NaturalizeAssistantState {
  total: number;
  completed: number;
  failed: number;
  complete: boolean;
  tone: 'running' | 'warning' | 'success' | 'neutral';
  label: string;
}

export function resolveNaturalizeAssistantState(
  contentStats: any,
  naturalizing?: boolean,
): NaturalizeAssistantState;

export function isPageMeasurementStale(
  sections: Record<string, { updated_at?: string }>,
  taskUpdatedAt: string | undefined,
  measuredPages: number,
): boolean;

export interface PageOptimizationReadiness {
  ready: boolean;
  reason: string;
}

export function resolvePageOptimizationReadiness(input?: {
  taskStatus?: string;
  sectionIds?: string[];
  sections?: Record<string, { status?: string; content?: string }>;
  runtime?: {
    section_words?: Record<string, number>;
    html_output?: {
      workspace_dir?: string;
      word_sections?: Array<{ section_id?: string; file?: string }>;
    };
  };
}): PageOptimizationReadiness;
