// Validación de variables de entorno al arranque (Spec §3).
// El servidor no debe iniciar si falta una variable requerida: en vez de un
// stack trace, se lanza un EnvValidationError con un mensaje accionable.

export type NodeEnv = "development" | "test" | "production";

export interface Env {
  DATABASE_URL: string;
  NODE_ENV: NodeEnv;
  PORT: number;
}

/**
 * Error tipado de configuración. Su `message` es apto para mostrarse al operador
 * (sin rastros de stack) y `missing`/`invalid` permiten inspección programática.
 */
export class EnvValidationError extends Error {
  readonly missing: string[];
  readonly invalid: string[];

  constructor(problems: { missing?: string[]; invalid?: string[] }) {
    const missing = problems.missing ?? [];
    const invalid = problems.invalid ?? [];

    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`faltan las variables requeridas: ${missing.join(", ")}`);
    }
    if (invalid.length > 0) {
      parts.push(`tienen un valor inválido: ${invalid.join(", ")}`);
    }

    super(
      `Configuración de entorno inválida (${parts.join("; ")}). ` +
        `Revisa .env.example y define estas variables antes de arrancar.`,
    );
    this.name = "EnvValidationError";
    this.missing = missing;
    this.invalid = invalid;
  }
}

const NODE_ENVS: readonly NodeEnv[] = ["development", "test", "production"];

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/**
 * Valida y normaliza las variables de entorno.
 * @throws {EnvValidationError} si falta una variable requerida o un valor es inválido.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const missing: string[] = [];
  const invalid: string[] = [];

  // Requerida.
  if (isBlank(source.DATABASE_URL)) {
    missing.push("DATABASE_URL");
  }

  // Opcional con default: development | test | production.
  const rawNodeEnv = source.NODE_ENV;
  let nodeEnv: NodeEnv = "development";
  if (!isBlank(rawNodeEnv)) {
    if (NODE_ENVS.includes(rawNodeEnv as NodeEnv)) {
      nodeEnv = rawNodeEnv as NodeEnv;
    } else {
      invalid.push("NODE_ENV");
    }
  }

  // Opcional con default: entero positivo.
  const rawPort = source.PORT;
  let port = 3000;
  if (!isBlank(rawPort)) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      invalid.push("PORT");
    } else {
      port = parsed;
    }
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new EnvValidationError({ missing, invalid });
  }

  return {
    DATABASE_URL: source.DATABASE_URL as string,
    NODE_ENV: nodeEnv,
    PORT: port,
  };
}
