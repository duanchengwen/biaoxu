export type OutlineContentMode = 'ai-generate' | 'template-fill' | 'directory-generate' | 'manual-fill' | 'other';

export const OUTLINE_CONTENT_MODE_LABELS: Record<OutlineContentMode, string> = {
  'ai-generate': 'AI生成',
  'template-fill': '模板填写',
  'directory-generate': '目录生成',
  'manual-fill': '人工填写',
  other: '其他模式',
};

export interface OutlineItem {
  id: string;
  title: string;
  description: string;
  attr?: '通用' | '商务/资信' | '技术' | '其他' | '目录' | '报价' | '业绩';
  content_mode?: OutlineContentMode;
  content_mode_note?: string;
  source_requirement_id?: string;
  source_requirement_title?: string;
  knowledge_item_ids?: string[];
  children?: OutlineItem[];
  content?: string;
}

export type OutlineMode = 'response-file' | 'standalone-technical' | 'standalone-business';
export type OutlineExpansionMode = 'original-only' | 'ai-complement';

export interface OutlineWordControlOptions {
  mode: 'pages' | 'words';
  minimumWords: number;
  maximumWords: number;
  sectionWords: number;
  /** 0 表示不控制；生成后按整本导出 Word 的实际分页结果闭环校正。 */
  targetPages: number;
  /** 0 表示不设置下限；有任一页数上下限时，区间是最终验收口径。 */
  minimumPages: number;
  /** 0 表示不设置上限；有任一页数上下限时，区间是最终验收口径。 */
  maximumPages: number;
}

export const DEFAULT_OUTLINE_WORD_CONTROL_OPTIONS: OutlineWordControlOptions = {
  mode: 'pages',
  minimumWords: 0,
  maximumWords: 0,
  sectionWords: 0,
  targetPages: 0,
  minimumPages: 0,
  maximumPages: 0,
};

export interface OutlineData {
  outline: OutlineItem[];
  project_name?: string;
  project_overview?: string;
}

/** 技术方案节点：身份固定，编号由当前树顺序计算。 */
export interface TechnicalPlanOutlineItem extends OutlineItem {
  number: string;
  children?: TechnicalPlanOutlineItem[];
}

export interface TechnicalPlanOutlineData extends OutlineData {
  outline: TechnicalPlanOutlineItem[];
}
