import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Toast = { id: number; text: string; kind: 'ok' | 'err' };
const Ctx = createContext<(text: string, kind?: 'ok' | 'err') => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const show = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    window.setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 5000 : 3000);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      {items.map((t, i) => (
        <div key={t.id} className={`toast ${t.kind}`} style={{ bottom: `calc(7rem + ${i * 3.2}rem)` }} role="status">{t.text}</div>
      ))}
    </Ctx.Provider>
  );
}
