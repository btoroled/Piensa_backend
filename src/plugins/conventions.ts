import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { AppError, SAFE_MESSAGES, errorBody } from "./errors.js";

/**
 * Convenciones transversales de la API (spec §5, §6):
 *
 * - Header `x-request-id` de correlación en toda respuesta (éxito o error),
 *   igual al `request.id` que también viaja en el body de error y en el log.
 * - Envelope de error único `{ error: { code, message, requestId } }`.
 * - Los detalles internos (stack, SQL, causa) nunca llegan al cliente:
 *   se registran completos en el log del servidor bajo el mismo requestId.
 *
 * Se registra con `fastify-plugin` para des-encapsular: el manejador de
 * errores y el de "no encontrado" aplican a toda la instancia, no solo a
 * un scope. El envelope de éxito `{ data }` lo construye cada handler.
 */
export const conventionsPlugin = fp(
  function conventions(app, _opts, done): void {
    // Correlación: el requestId acompaña toda respuesta.
    app.addHook("onRequest", (request, reply, hookDone) => {
      reply.header("x-request-id", request.id);
      hookDone();
    });

    app.setErrorHandler(handleError);
    app.setNotFoundHandler(handleNotFound);

    done();
  },
  { name: "api-conventions" },
);

function handleError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;

  // Error de validación de JSON Schema (Fastify adjunta `validation`).
  if (error.validation) {
    request.log.warn(
      { err: error, validation: error.validation },
      "solicitud rechazada por validación",
    );
    void reply
      .status(400)
      .send(
        errorBody("VALIDATION_ERROR", buildValidationMessage(error), requestId),
      );
    return;
  }

  // Error de dominio tipado: mensaje seguro provisto por quien lo lanza.
  if (error instanceof AppError) {
    request.log.warn({ err: error, code: error.code }, "error de dominio");
    void reply
      .status(error.statusCode)
      .send(errorBody(error.code, error.message, requestId));
    return;
  }

  // Errores del framework con estado 4xx conocido (p. ej. body malformado).
  const status = error.statusCode ?? 500;
  if (status >= 400 && status < 500) {
    request.log.warn({ err: error }, "error de cliente");
    void reply
      .status(status)
      .send(
        errorBody(
          "VALIDATION_ERROR",
          SAFE_MESSAGES.VALIDATION_ERROR,
          requestId,
        ),
      );
    return;
  }

  // Cualquier otra cosa es un fallo interno: el detalle completo va al log,
  // el cliente solo recibe un mensaje genérico bajo su requestId.
  request.log.error({ err: error }, "error interno no controlado");
  void reply
    .status(500)
    .send(errorBody("INTERNAL", SAFE_MESSAGES.INTERNAL, requestId));
}

function handleNotFound(request: FastifyRequest, reply: FastifyReply): void {
  const requestId = request.id;
  request.log.info(
    { method: request.method, url: request.url },
    "ruta no encontrada",
  );
  void reply
    .status(404)
    .send(errorBody("NOT_FOUND", SAFE_MESSAGES.NOT_FOUND, requestId));
}

/**
 * Mensaje de validación apto para el cliente: describe el campo en falta o
 * inválido sin exponer valores enviados ni detalles internos.
 */
function buildValidationMessage(error: FastifyError): string {
  const first = error.validation?.[0];
  if (!first) return SAFE_MESSAGES.VALIDATION_ERROR;
  const path = first.instancePath ? first.instancePath.replace(/^\//, "") : "";
  const where = path.length > 0 ? `'${path}'` : "la solicitud";
  return `Campo inválido: ${where} ${first.message ?? "no cumple el esquema"}.`;
}
