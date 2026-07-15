// Cliente Prisma compartido. La construcción es perezosa (no abre conexión
// hasta la primera consulta), así que importarlo no requiere una BD disponible;
// solo las rutas que consultan la necesitan. En tests de integración se puede
// inyectar un cliente propio a `buildApp` para controlar su ciclo de vida.

import { PrismaClient } from "@prisma/client";

let singleton: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  singleton ??= new PrismaClient();
  return singleton;
}
