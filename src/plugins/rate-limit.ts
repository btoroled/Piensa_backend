// Rate limiting (Spec §6, ISSUE-11).
//
// `@fastify/rate-limit` con un límite global por IP y un límite estricto por-ruta
// sobre los endpoints de credenciales (`/auth/login`, `/auth/student-session`).
// El hook corre en `onRequest`, antes de la validación y del handler: un request
// limitado nunca toca la BD. La respuesta reusa el envelope de error estándar
// `{ error: { code: "RATE_LIMITED", message, requestId } }` para que el cliente
// decida por `code`, igual que el resto de la API.
//
// Store en memoria (default del plugin): suficiente para v1 single-instance. Un
// store distribuido (Redis) para multi-instancia queda fuera de alcance.

import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { AppError, SAFE_MESSAGES } from "./errors.js";

/** Parámetros de un limitador: máximo de peticiones por ventana (en ms). */
export interface RateLimitRule {
  max: number;
  timeWindow: number;
}

export interface RateLimitConfig {
  /** Límite global por IP sobre toda la API. */
  global: RateLimitRule;
  /** Límite estricto por IP sobre los endpoints de credenciales. */
  auth: RateLimitRule;
}

/** Límites de producción por defecto (ajustables vía `buildApp`). */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  global: { max: 100, timeWindow: 60_000 },
  auth: { max: 10, timeWindow: 60_000 },
};

export interface RateLimitPluginOptions {
  config: RateLimitConfig;
}

/**
 * Registra el rate limiting global. Debe registrarse DESPUÉS de
 * `conventionsPlugin` para que el `x-request-id` ya esté puesto cuando el
 * limitador responda. Las rutas de credenciales aplican su límite estricto vía
 * `config.rateLimit` por-ruta (ver `authRoutes`).
 */
export const rateLimitPlugin = fp<RateLimitPluginOptions>(
  async function rateLimiting(app, opts) {
    await app.register(rateLimit, {
      global: true,
      max: opts.config.global.max,
      timeWindow: opts.config.global.timeWindow,
      // El plugin LANZA lo que devuelve este builder; devolver un AppError deja
      // que el manejador de errores estándar produzca el envelope (429 + código
      // RATE_LIMITED + requestId), sin duplicar la lógica de respuesta.
      errorResponseBuilder: () =>
        new AppError("RATE_LIMITED", SAFE_MESSAGES.RATE_LIMITED),
    });
  },
  { name: "rate-limit" },
);
