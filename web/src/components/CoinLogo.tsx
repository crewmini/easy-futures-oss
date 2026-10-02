import type { Symbol } from '@easy-futures/shared';

/** 코인 로고 (인라인 SVG, 외부 이미지 없음). */
export function CoinLogo({ symbol, size = 28 }: { symbol: Symbol; size?: number }) {
  if (symbol === 'BTCUSDT') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: 'none' }}>
        <circle cx="16" cy="16" r="16" fill="#F7931A" />
        <path fill="#fff" d="M22.6 14.1c.3-2.1-1.3-3.2-3.5-4l.7-2.8-1.7-.4-.7 2.7c-.5-.1-.9-.2-1.4-.3l.7-2.8-1.7-.4-.7 2.8-1.1-.3-2.4-.6-.5 1.8s1.3.3 1.3.3c.7.2.8.6.8 1l-.8 3.2v.2l-1.1 4.5c-.1.2-.3.5-.8.4 0 0-1.3-.3-1.3-.3l-.9 2 2.2.6 1.2.3-.7 2.8 1.7.4.7-2.8c.5.1.9.2 1.4.4l-.7 2.8 1.7.4.7-2.8c2.9.6 5.1.3 6-2.3.7-2.1 0-3.3-1.5-4.1 1.1-.3 2-1 2.2-2.5zm-4 5.4c-.5 2.1-4.1 1-5.2.7l1-3.8c1.1.3 4.7.8 4.2 3.1zm.5-5.4c-.5 1.9-3.4.9-4.4.7l.8-3.4c1 .2 4 .7 3.6 2.7z" />
      </svg>
    );
  }
  if (symbol === 'SOLUSDT') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: 'none' }}>
        <circle cx="16" cy="16" r="16" fill="#1a1a2e" />
        <defs><linearGradient id="solg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#9945FF" /><stop offset="1" stopColor="#14F195" /></linearGradient></defs>
        <path fill="url(#solg)" d="M10.2 9.5h12.6l-2.6 2.6H7.6zM10.2 20h12.6l-2.6 2.6H7.6zM21.6 14.7H9l2.6 2.6h12.6z" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" style={{ flex: 'none' }}>
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <path fill="#fff" fillOpacity=".6" d="M16.5 4v8.9l7.5 3.3z" />
      <path fill="#fff" d="M16.5 4L9 16.2l7.5-3.3z" />
      <path fill="#fff" fillOpacity=".6" d="M16.5 22v6L24 17.6z" />
      <path fill="#fff" d="M16.5 28v-6L9 17.6z" />
      <path fill="#fff" fillOpacity=".2" d="M16.5 20.6l7.5-4.4-7.5-3.3z" />
      <path fill="#fff" fillOpacity=".6" d="M9 16.2l7.5 4.4v-7.7z" />
    </svg>
  );
}
