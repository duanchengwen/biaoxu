export const WORDS_PER_PAGE: 650;
export const PAGE_WORD_TOLERANCE: 0.15;
export const DEFAULT_SECTION_WORDS: 3000;
export const PAGE_BUDGET_DISCLAIMER: string;

export interface PageWordBudget {
  targetPages: number;
  estimatedWords: number;
  minimumWords: number;
  maximumWords: number;
  wordsPerPage: number;
  tolerance: number;
  disclaimer: string;
}

export interface OutlineWordControlBudget {
  mode: 'pages' | 'words';
  minimumWords: number;
  maximumWords: number;
  sectionWords: number;
  targetPages: number;
  minimumPages: number;
  maximumPages: number;
}

export interface PageConstraint {
  enabled: boolean;
  kind: 'none' | 'exact' | 'range';
  targetPages: number;
  minimumPages: number;
  maximumPages: number;
  planningPages: number;
}

export interface PlanningWordControl extends OutlineWordControlBudget {
  planningPages: number;
  pageBudget: Readonly<PageWordBudget> | null;
}

export function estimatePageWordBudget(targetPages: unknown): Readonly<PageWordBudget> | null;
export function normalizeWordControlOptions(value: unknown): OutlineWordControlBudget;
export function validateWordControlOptions(value: unknown): OutlineWordControlBudget;
export function resolvePageConstraint(value: unknown): Readonly<PageConstraint>;
export function isPageCountAccepted(actualPages: unknown, constraintOrOptions: unknown): boolean;
export function pageCountDistance(actualPages: unknown, constraintOrOptions: unknown): number;
export function pageAdjustmentTarget(actualPages: unknown, constraintOrOptions: unknown): number;
export function derivePlanningWordControl(value: unknown): PlanningWordControl;
