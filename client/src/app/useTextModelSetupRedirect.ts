import { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsPageRequest } from '../features/settings/types';
import type { SectionId } from '../shared/types/navigation';
import { useToast } from '../shared/ui';

// 文本模型未配置时统一跳到设置-文本模型；不读取官方账户，也不触发充值流程。
export function useTextModelSetupRedirect(requestSectionChange: (section: SectionId) => Promise<boolean>) {
  const [settingsRequest, setSettingsRequest] = useState<SettingsPageRequest | null>(null);
  const { showToast } = useToast();
  const redirectRef = useRef<(message: string) => void>(() => undefined);

  // 订阅只建立一次，跳转时通过 ref 使用最新的切页函数。
  useEffect(() => {
    redirectRef.current = (message) => {
      showToast(message, 'info');
      // 先写入请求，设置页挂载时直接显示目标分类；离开被拦截时撤回。
      setSettingsRequest({ tab: 'text-model' });
      void requestSectionChange('settings').then((allowed) => {
        if (!allowed) setSettingsRequest(null);
      });
    };
  });

  useEffect(() => {
    let disposed = false;

    void window.yibiao.config.load()
      .then((config) => {
        if (disposed) return;
        if (config.text_model_provider === 'official') {
          redirectRef.current('原官方 API 已从增强版移除，请配置第三方或自定义文本模型');
        } else if (!config.api_key || !config.model_name || !config.base_url) {
          redirectRef.current('文本模型尚未配置，请先完成设置');
        }
      })
      .catch((error) => console.warn('读取文本模型配置失败', error));

    return () => {
      disposed = true;
    };
  }, []);

  const clearSettingsRequest = useCallback(() => setSettingsRequest(null), []);
  return { settingsRequest, clearSettingsRequest };
}
