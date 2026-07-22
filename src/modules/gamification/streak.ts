// Rachas diarias (ISSUE-26). La racha se calcula sobre la fecha-calendario en la
// zona horaria de la familia (no UTC), derivada con Intl (DST-safe). Mismo día
// local → sin cambio; día siguiente → +1; brecha ≥2 días → reinicia a 1.

import type { PrismaClient } from "@prisma/client";

/** Zona horaria por defecto (Perú) si la familia no tiene una válida. */
export const DEFAULT_TIMEZONE = "America/Lima";

/** True si `tz` es una zona horaria IANA válida. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Fecha-calendario ("YYYY-MM-DD") de `now` en la zona `timeZone`. */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
