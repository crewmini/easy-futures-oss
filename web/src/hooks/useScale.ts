import { useEffect, useState } from 'react';
export type Scale = '1' | '1.25' | '1.5';
export const SCALE_LABEL: Record<Scale, string> = { '1': '보통', '1.25': '크게', '1.5': '아주 크게' };
const KEY = 'ef.scale';
export function useScale(): [Scale, (s: Scale) => void] {
  const [scale, set] = useState<Scale>(() => {
    try { const v = localStorage.getItem(KEY) as Scale | null; return v && v in SCALE_LABEL ? v : '1'; } catch { return '1'; }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-scale', scale);
    try { localStorage.setItem(KEY, scale); } catch { /* ignore */ }
  }, [scale]);
  return [scale, set];
}
