import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './styles.css';

// 예전 주소(workers.dev)로 열리면 정식 주소로 이동 (정적 파일은 워커를 거치지 않아 여기서 처리)
const CANONICAL_HOST = (import.meta.env.VITE_CANONICAL_HOST as string | undefined)?.trim(); // web/.env.production. 비우면 어느 주소든 그대로
if (CANONICAL_HOST && (location.hostname.endsWith('.workers.dev') || location.hostname === 'www.' + CANONICAL_HOST)) {
  location.replace('https://' + CANONICAL_HOST + location.pathname + location.search);
}

registerSW({ immediate: true });
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
