/** Easy futures 로고 마크 (EF + 상승선). 앱 아이콘과 동일. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" style={{ flex: 'none', borderRadius: size * 0.22 }}>
      <rect width="512" height="512" rx="110" fill="#111111" />
      <path d="M84 352 L176 262 L246 318 L428 150" fill="none" stroke="#ff5a5a" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M356 150 H428 V222" fill="none" stroke="#ff5a5a" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round" />
      <text x="96" y="452" fontFamily="-apple-system, 'Helvetica Neue', Arial, sans-serif" fontSize="118" fontWeight="900" fill="#ffffff" letterSpacing="-4">EF</text>
    </svg>
  );
}
