import { ApiError } from './api';

/**
 * 한 지갑 공유 가드 (2026-09-22): 고수 따라하기로 들어간 종목을 직접 주문(진입·정리·손절 변경)하면
 * 서버가 409 COPY_SYMBOL_LOCKED(detail.masterNickname) 로 거절한다. 확인 창을 거쳐 force:true 로 다시 보낸다.
 *
 * - knownNickname: 화면이 이미 그 포지션이 따라 들어간 것임을 알면(position.copy) 서버에 보내기 전에 먼저 묻는다.
 * - 반환 null = 사용자가 "취소" (호출 쪽은 조용히 멈추면 된다). 그 외 오류는 그대로 던진다.
 */
export const copyLockMessage = (masterNickname: string | null | undefined) =>
  `이 포지션은 ${masterNickname ? `${masterNickname} ` : ''}고수 따라하기로 들어간 포지션이에요. 직접 바꾸면 고수를 따라가지 못하고 손절이 겹칠 수 있어요. 그래도 진행할까요?`;

export function isCopyLocked(e: unknown): e is ApiError & { detail?: { symbol?: string; masterNickname?: string } } {
  return e instanceof ApiError && e.status === 409 && e.code === 'COPY_SYMBOL_LOCKED';
}

export async function withCopyLockConfirm<T>(fn: (force: boolean) => Promise<T>, knownNickname?: string | null): Promise<T | null> {
  let force = false;
  if (knownNickname != null) {
    if (!window.confirm(copyLockMessage(knownNickname))) return null;
    force = true;
  }
  try {
    return await fn(force);
  } catch (e) {
    if (!isCopyLocked(e) || force) throw e;
    const nick = typeof e.detail === 'object' && e.detail && typeof e.detail.masterNickname === 'string' ? e.detail.masterNickname : null;
    if (!window.confirm(copyLockMessage(nick))) return null;
    return await fn(true);
  }
}
