// 브로커 어댑터 계약: paper(연습) / woox(실거래) 가 같은 모양으로 라우트에 붙는다.
import type {
  TradeHistoryItem, ContractInfo, OpenOrderRequest, OpenOrderResult, Position, Price, Symbol, UpdateTpSlRequest, Wallet } from '@easy-futures/shared';

/** 정리 결과 (알 수 있을 때만). contracts = 실제 정리된 계약 수, pnl/fee 는 어댑터가 알면 채운다 (연습 엔진은 정확히, 거래소는 null → 호출자가 추정) */
export interface CloseResult { contracts: number; pnl: number | null; fee: number | null }
/** 주문 옵션. clientOrderId 는 거래소에 함께 보내는 내 주문 표식(≤32 영숫자) — 실행기가 죽어도 체결 여부를 되찾는다. 여러 번 나눠 주문하면 어댑터가 뒤에 시도 번호를 붙인다 */
export interface OrderOpts { clientOrderId?: string }

/** 거래소 포지션 모드 (실거래만). hedge = 양방향(같은 종목에 롱·숏 동시) — 앱은 단방향(one_way)을 가정한다. 표시용이며 거래 동작은 바꾸지 않는다 */
export type PositionMode = 'hedge' | 'one_way' | 'unknown';

export interface BrokerAdapter {
  /** 지갑 + 포지션. prices 는 PaperEngine 이 주는 공용 시세(실거래 어댑터는 mark 보정용). rawPositionCount = 앱 종목 필터 전 열린 포지션 수 (실거래만 — 감시자의 VANISHED 판정용). positionMode = 포지션 행의 position_mode 로 추정(실거래만) */
  getAccount(contracts: Record<Symbol, ContractInfo>, prices: Partial<Record<Symbol, Price>>): Promise<{ wallet: Wallet; positions: Position[]; rawPositionCount?: number; positionMode?: PositionMode }>;
  /** 최근 days 일 거래 내역(최신순). */
  getHistory(days: number, contracts: Record<Symbol, ContractInfo>): Promise<TradeHistoryItem[]>;
  /** 시장가 진입 + 손절(필수)/익절(선택). contracts 는 라우트에서 계산. 결과의 contracts 는 실제 체결된 계약 수 (실거래: 포지션 증가분) */
  openOrder(req: OpenOrderRequest, contracts: number, contract: ContractInfo, currentPrice: number, opts?: OrderOpts): Promise<OpenOrderResult>;
  /** 전량 정리 + TP/SL 취소. 결과를 알면 돌려준다 */
  closePosition(symbol: Symbol, contract: ContractInfo, opts?: OrderOpts): Promise<CloseResult | void>;
  /** 부분 정리: contracts 만큼만 반대 방향으로 정리. 남은 수량이 0 이 되면 TP/SL 도 취소, 남으면 그대로 둔다. (카피 트레이딩 reduce) */
  reducePosition(symbol: Symbol, contracts: number, contract: ContractInfo, opts?: OrderOpts): Promise<CloseResult | void>;
  updateTpSl(req: UpdateTpSlRequest, contract: ContractInfo): Promise<void>;
  /** 열린 포지션의 배율 변경 (격리). 포지션이 없으면 404. (카피 트레이딩 leverage 이벤트) */
  setLeverage(symbol: Symbol, leverage: number): Promise<void>;
  /** 현재 포지션 방향(검증용). 없으면 null. */
  getPositionDirection(symbol: Symbol): Promise<Position['direction'] | null>;
  /** (실거래만) 손절 플랜 주문이 걸려 있는가 — 엄격 조회, 실패하면 던진다. 연습 엔진은 구현하지 않는다(진입에 손절이 항상 붙는다) */
  hasStopLoss?(symbol: Symbol): Promise<boolean>;
  /** (실거래만) 주문 표식으로 체결 수량 확인 (실행기가 죽은 뒤 복구). 못 찾으면 null, 조회 실패는 던진다 */
  findFill?(symbol: Symbol, clientOrderId: string): Promise<{ dealSize: number; dealAvgPrice: number | null; orderId?: string | null } | null>;
}
