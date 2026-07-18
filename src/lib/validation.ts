// Patterns de validación compartidos (fuente única). Fastify usa ajv con
// `coerceTypes: true`, así que validar por `type` coacciona en vez de rechazar;
// estos patterns anclados (^...$) rechazan tipos coaccionados y formas
// inválidas. Centralizados para que endurecer uno cubra a todos los consumidores
// (evita el drift por copy-paste, que es donde viven los bugs de validación).

// UUID validado por `pattern` (ajv-formats no está registrado). Cubre las
// variantes hex minúscula/mayúscula que produce Prisma.
export const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

// Email deliberadamente conservador: descarta tipos coaccionados y formas
// obviamente inválidas. La validación real de existencia la hace el servicio.
export const EMAIL_PATTERN = "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$";

// PIN de exactamente 4 dígitos.
export const PIN_PATTERN = "^[0-9]{4}$";
