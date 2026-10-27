import { useCallback } from 'react';
import type { AppMenuNotice } from '../types/navigation';
import { useToast } from './ToastProvider';

export const githubStarNotice: AppMenuNotice = {
  message: '该功能尚未开放，请留意后续版本更新。',
};

// 以提示条展示未开放功能说明，有外部链接时附带直达按钮。
export function useNoticeToast() {
  const { showToast } = useToast();

  return useCallback((notice: AppMenuNotice) => {
    const { externalUrl } = notice;
    showToast(notice.message, 'info', {
      duration: 7000,
      actions: externalUrl ? [
        {
          label: notice.actionLabel || '打开链接',
          variant: 'primary',
          onClick: () => openExternalUrl(externalUrl),
        },
      ] : undefined,
    });
  }, [showToast]);
}

async function openExternalUrl(url: string) {
  if (window.yibiao?.openExternal) {
    await window.yibiao.openExternal(url);
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}
