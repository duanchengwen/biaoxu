export type GenerationSettingsTab = 'content' | 'existing-plan' | 'knowledge' | 'length' | 'illustration' | 'writing' | 'appearance';

// 生成设置页签顺序同时决定工具条逐项前进与回退的顺序。
export const generationSettingsTabs: Array<{ id: GenerationSettingsTab; label: string }> = [
  { id: 'content', label: '生成范围' },
  { id: 'existing-plan', label: '已有方案' },
  { id: 'knowledge', label: '参考资料' },
  { id: 'length', label: '目标篇幅' },
  { id: 'illustration', label: '配图设置' },
  { id: 'writing', label: '写作规则' },
  { id: 'appearance', label: '版式模板' },
];
