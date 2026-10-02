// API 오류 → { error, code?, detail? } + HTTP 상태.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string | number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code?: string | number, detail?: unknown) =>
  new HttpError(400, message, code, detail);
