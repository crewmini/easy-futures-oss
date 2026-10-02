// 연습 모드 어댑터: 모든 일을 PaperEngine DO 에 위임한다.
import type {
  TradeHistoryItem, ContractInfo, OpenOrderRequest, OpenOrderResult, Position, Symbol, UpdateTpSlRequest, Wallet } from '@easy-futures/shared';
import type { PaperClient } from '../paper/client.js';
import type { BrokerAdapter, CloseResult } from './types.js';

export class PaperAdapter implements BrokerAdapter {
  constructor(
    private readonly paper: PaperClient,
    private readonly userId: number,
  ) {}

  async getHistory(days: number, contracts: Record<Symbol, ContractInfo>): Promise<TradeHistoryItem[]> {
    const s = await this.paper.state(this.userId);
    const since = Date.now() - days * 86_400_000;
    const out: TradeHistoryItem[] = [];
    for (const ev of s.history) {
      if (ev.t < since || !ev.symbol || !ev.direction || !ev.contracts || !ev.price) continue;
      if (ev.type !== 'open' && ev.type !== 'close' && ev.type !== 'sl' && ev.type !== 'tp' && ev.type !== 'liq') continue;
      out.push({
        id: `paper-${ev.t}-${ev.type}-${ev.symbol}`,
        time: ev.t,
        symbol: ev.symbol,
        kind: ev.type,
        direction: ev.direction,
        contracts: ev.contracts,
        coinAmount: ev.contracts * (contracts[ev.symbol]?.contractSize ?? 0),
        price: ev.price,
        pnl: ev.type === 'open' ? null : (ev.pnl ?? null),
        fee: ev.fee ?? null,
        leverage: null,
        orderId: ev.orderId ?? null,
      });
    }
    return out.sort((a, b) => b.time - a.time);
  }

  async getAccount(): Promise<{ wallet: Wallet; positions: Position[] }> {
    const s = await this.paper.state(this.userId);
    return { wallet: s.wallet, positions: s.positions };
  }

  openOrder(req: OpenOrderRequest, contracts: number, contract: ContractInfo): Promise<OpenOrderResult> {
    return this.paper.open(this.userId, req, contracts, contract);
  }

  async closePosition(symbol: Symbol): Promise<CloseResult> {
    const r = await this.paper.close(this.userId, symbol);
    return { contracts: r.contracts ?? 0, pnl: r.pnl ?? null, fee: r.fee ?? null };
  }

  async reducePosition(symbol: Symbol, contracts: number): Promise<CloseResult> {
    const r = await this.paper.reduce(this.userId, symbol, contracts);
    return { contracts: r.contracts, pnl: r.pnl, fee: r.fee };
  }

  async updateTpSl(req: UpdateTpSlRequest): Promise<void> {
    await this.paper.tpsl(this.userId, req);
  }

  async setLeverage(symbol: Symbol, leverage: number): Promise<void> {
    await this.paper.setLeverage(this.userId, symbol, leverage);
  }

  async getPositionDirection(symbol: Symbol): Promise<Position['direction'] | null> {
    const s = await this.paper.state(this.userId);
    return s.positions.find((p) => p.symbol === symbol)?.direction ?? null;
  }
}
