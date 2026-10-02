// 바깥 네트워크 호출 지점 하나 — 테스트에서 가짜로 바꾼다 (텔레그램·캔들 API)
export const net = { fetch: (input: string, init?: RequestInit): Promise<Response> => fetch(input, init) };
