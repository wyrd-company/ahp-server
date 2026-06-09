import type { JsonRpcError } from './types.js';

export const JsonRpcErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ProviderNotFound: -32002,
  SessionAlreadyExists: -32003,
  UnsupportedProtocolVersion: -32005,
  NotFound: -32008,
} as const;

export class AhpServerError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'AhpServerError';
    this.code = code;
    this.data = data;
  }

  toJsonRpcError(): JsonRpcError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function toJsonRpcError(error: unknown): JsonRpcError {
  if (error instanceof AhpServerError) {
    return error.toJsonRpcError();
  }
  if (error instanceof Error) {
    return { code: JsonRpcErrorCodes.InternalError, message: error.message };
  }
  return { code: JsonRpcErrorCodes.InternalError, message: String(error) };
}

