# Rescate del proyecto anterior (Piensa-Homeschool, Java/Spring Boot + React)

El proyecto anterior vive en GitHub (`btoroled/Piensa-Homeschool`, rama `main`) y hay un
clon local de referencia en `~/Documents/piensa-legacy`. El backend era Java 21 /
Spring Boot 3 (no portable directamente a Node), pero contiene **lógica de negocio ya
validada con tests** que conviene portar a TypeScript en vez de reinventar, y un
**frontend React 18 + TS + Vite + Tailwind** que coincide exactamente con el stack nuevo.

## Lógica pura para portar a TypeScript (backend)

| Qué | Archivo legacy | Issue destino | Notas |
|---|---|---|---|
| Cálculo de racha diaria | `src/main/java/com/piensa/homeschool/progreso/RachaCalculator.java` | ISSUE-26 | Lógica pura con reglas claras: mismo día no acumula, día siguiente +1, hueco reinicia a 1; incluye `rachaVigente` (racha "viva" si la última actividad fue hoy o ayer — útil para `GET /me/summary`). **Falta agregarle zona horaria de la familia** (requisito nuevo del spec). |
| Calificación de respuestas | `src/main/java/com/piensa/homeschool/common/Calificador.java` | ISSUE-23 | Patrón correcto ya probado: función pura compartida entre práctica y evaluación; opción múltiple por índice con parseo defensivo (respuesta malformada → incorrecta, nunca excepción); respuesta corta con trim + case-insensitive. Extender con normalización de acentos según el spec nuevo. |
| Clasificación y normalización de URLs de video | `src/main/java/com/piensa/homeschool/curso/video/VideoUrls.java` (+ `VideoUrlsTest.java`) | ISSUE-14 | Regex probada para extraer el ID de YouTube (watch/youtu.be/embed/shorts), `toEmbedUrl()` para iframe, detección de proveedor con puerta abierta a almacenamiento propio. Portar junto con sus tests. |
| Puntos por lección | `progreso/GamificacionService.java` | ISSUE-22, ISSUE-25 | Confirma la constante +10 XP por lección y la regla "otorgar solo la primera vez" (idempotencia), ya en el spec. |

## Frontend: reusar como semilla de `piensa-frontend`

El stack coincide (React + TS + Tailwind). Aunque la UX nueva es distinta (camino estilo
Duolingo, perfiles de alumno con PIN), la **plomería** es directamente aprovechable:

- `frontend/src/auth/` — `RequireAuth`, `RequireRole`, `roleRouting`: ruteo por rol ya resuelto.
- `frontend/src/contexts/AuthContext.tsx` — manejo de sesión.
- `frontend/src/api/` — patrón de clientes axios tipados por módulo + manejo central de errores (`errors.ts`).
- `frontend/src/types/` — patrón de espejos de DTOs del backend.
- `frontend/src/components/` — design system inicial: `Modal`, `ProgressBar`, `ErrorBanner`, `StatusBanner`, `DashboardLayout`, `NotificationBell`, `VideoPlayer`, `EjercicioInteractivo` (componente de ejercicio interactivo ya funcional).
- Páginas por rol (`pages/admin`, `pages/alumno`, `pages/padre`) — referencia de flujo, no de diseño.

Decisión pendiente al arrancar `piensa-frontend`: sembrar el repo desde este frontend y
rediseñar encima, o empezar limpio copiando módulos puntuales.

## Tests legacy como especificación de comportamiento

`src/test/java/...` (MockMvc + unitarios) documenta casos borde ya pensados: aislamiento
de BD entre tests de integración, seguridad por rol, validación de URLs de video, corrección
de ejercicios. Al implementar el issue equivalente, revisar el test legacy correspondiente
antes de escribir los casos nuevos.

## Qué NO rescatar (decisión de diseño del spec nuevo)

- **Modelo de cursos/unidades/profesor**: el spec nuevo usa Grade → Week → Lesson sin rol profesor.
- **Vínculo padre-hijo con aprobación** (`VinculoPadreHijo`, `EstadoVinculo`): el spec nuevo lo simplifica — la familia es dueña de los perfiles.
- **JWT en cookie httpOnly**: el spec nuevo usa access + refresh rotativo (hay app móvil).
- **Evaluaciones formales como módulo aparte**: cubierto por `QuizAttempt` en el spec nuevo.
- **Notificaciones in-app y reporte PDF (OpenPDF)**: fuera de alcance v1; anotados como candidatos v2.
