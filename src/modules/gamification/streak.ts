// Rachas diarias (ISSUE-26). La racha se calcula sobre la fecha-calendario en la
// zona horaria de la familia (no UTC), derivada con Intl (DST-safe). Mismo día
// local → sin cambio; día siguiente → +1; brecha ≥2 días → reinicia a 1.

import type { Prisma } from "@prisma/client";

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

/** Fecha-calendario ("YYYY-MM-DD") de un valor `@db.Date` (guardado a medianoche UTC). */
function storedDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Diferencia en días-calendario entre dos "YYYY-MM-DD" (b - a). */
function dayDiff(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** Zona horaria de la familia del alumno (default si es inválida o falta). */
export async function familyTimezoneForStudent(
  db: Prisma.TransactionClient,
  studentProfileId: string,
): Promise<string> {
  const student = await db.studentProfile.findUniqueOrThrow({
    where: { id: studentProfileId },
    select: { family: { select: { timezone: true } } },
  });
  const tz = student.family.timezone;
  return isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/** Registra actividad del día y actualiza la racha en la zona de la familia.
 *  Mismo día local → sin cambio; día siguiente → +1; brecha ≥2 → reinicia a 1.
 *  Si `timezone` es inválida, cae al default (nunca revienta la actividad). */
export async function recordActivity(
  db: Prisma.TransactionClient,
  studentProfileId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<{ current: number; longest: number }> {
  const tz = isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const today = localDate(now, tz);

  const existing = await db.streak.findUnique({ where: { studentProfileId } });

  let current: number;
  if (!existing || existing.lastActivityDate == null) {
    current = 1;
  } else {
    const diff = dayDiff(storedDate(existing.lastActivityDate), today);
    if (diff <= 0)
      current = existing.current; // mismo día (o reloj hacia atrás)
    else if (diff === 1) current = existing.current + 1;
    else current = 1;
  }
  const longest = Math.max(existing?.longest ?? 0, current);
  const lastActivityDate = new Date(`${today}T00:00:00Z`);

  const saved = await db.streak.upsert({
    where: { studentProfileId },
    create: { studentProfileId, current, longest, lastActivityDate },
    update: { current, longest, lastActivityDate },
  });
  return { current: saved.current, longest: saved.longest };
}
