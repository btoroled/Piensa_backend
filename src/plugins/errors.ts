/**
 * Catálogo tipado de códigos de error de la API (spec §5, §6).
 *
 * Los clientes deciden por `code`, nunca parseando `message`. Agregar un
 * código nuevo aquí es el único punto de extensión: el `union` `ErrorCode`
 * y el mapa de estados HTTP se mantienen exhaustivos en compilación.
 */
export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "FAMILY_SUSPENDED",
  "ACCOUNT_SUSPENDED",
  "INVALID_PIN",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Estado HTTP estable por código de error. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  INVALID_PIN: 401,
  FORBIDDEN: 403,
  FAMILY_SUSPENDED: 403,
  ACCOUNT_SUSPENDED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

/**
 * Error de dominio con código estable del catálogo. Los handlers lanzan
 * `AppError`; el manejador central lo traduce al envelope de error.
 *
 * `message` es apto para el cliente (sin detalles internos). El detalle
 * técnico, si lo hay, va en `cause` y solo se registra en el log del servidor.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusForCode(code);
  }
}

/** Forma exacta del envelope de error que recibe el cliente. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
  };
}

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
): ErrorBody {
  return { error: { code, message, requestId } };
}

/** Mensajes seguros por defecto (no filtran detalles internos). */
export const SAFE_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "La solicitud no es válida.",
  UNAUTHORIZED: "No autenticado.",
  INVALID_PIN: "PIN incorrecto.",
  FORBIDDEN: "No tienes permiso para esta acción.",
  FAMILY_SUSPENDED: "La familia está suspendida.",
  ACCOUNT_SUSPENDED: "La cuenta está suspendida.",
  NOT_FOUND: "Recurso no encontrado.",
  CONFLICT: "El recurso no se puede modificar por su estado actual.",
  RATE_LIMITED: "Demasiadas solicitudes. Intenta más tarde.",
  INTERNAL: "Ocurrió un error interno.",
};
