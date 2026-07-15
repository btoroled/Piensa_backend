# Piensa Homeschool — Backend Issues (Spec-Driven Development)

**Spec fuente de verdad:** [`docs/specs/2026-07-14-piensa-backend-design.md`](docs/specs/2026-07-14-piensa-backend-design.md)
**Lógica rescatada del proyecto anterior:** [`docs/legacy-rescue.md`](docs/legacy-rescue.md) — revisar antes de implementar ISSUE-14, 22, 23, 25 y 26.

## Reglas SDD (aplican a todos los issues)

1. **El spec manda.** Cada issue referencia la sección del spec que implementa (§). Si durante la implementación se descubre que el spec está mal o incompleto, **primero se actualiza el spec** (con aprobación), luego el issue.
2. **TDD obligatorio.** Cada issue empieza escribiendo el test que falla (derivado de los criterios de aceptación), luego la implementación mínima, luego commit. Nada se cierra sin tests en verde.
3. **Definition of Done** para todo issue: criterios de aceptación cumplidos y demostrados por tests · validación de entrada con JSON Schema en toda ruta nueva · errores con formato `{ error: { code, message } }` y código estable · sin respuestas correctas ni detalles internos filtrados al cliente · CI en verde · commit(s) descriptivos.
4. **Orden:** los milestones son secuenciales; dentro de un milestone, respetar las dependencias indicadas (`Depende de:`).
5. **YAGNI:** nada fuera del alcance v1 (spec §8). Los issues marcados `[v2]` no se implementan ahora; existen solo para no romper su punto de extensión.

**Stack (spec §2):** Node.js + TypeScript · Fastify · Prisma · PostgreSQL · Cloudflare R2 · JWT (access 15 min + refresh rotativo) · argon2 · Vitest · Docker Compose · GitHub Actions.

---

## Tablero de estado

> Mantenido **únicamente por docs-agent** según los reportes del equipo. Última actualización: 2026-07-14.
> Estados: ⚪ Pendiente · 🟡 En progreso · 🔵 En revisión · ✅ Completado · 🔴 Bloqueado

| Issue | Estado | Responsable | Nota |
|---|---|---|---|
| ISSUE-01 Scaffolding | ✅ Completado | impl · review OK | mergeado a `main` (2026-07-14) · 8 tests verdes · criterios 3/3 · lint/typecheck/build OK |
| ISSUE-02 Entorno Docker + validación de env | ✅ Completado | impl · review OK | PR #1 · mergeado a `main` (2026-07-14) · 23 tests verdes · criterios 3/3 · arranque sin `DATABASE_URL` → exit 1 sin stack |
| ISSUE-03 Convenciones de API | ✅ Completado | impl · review OK | PR #2 · mergeado a `main` (2026-07-14) · 14 tests verdes · criterios 5/5 · auditoría de seguridad (x-request-id / SQL sensible sin filtración) |
| ISSUE-04 CI en GitHub Actions | ✅ Completado | impl · review OK | PR #3 · mergeado a `main` (2026-07-14) · CI verde · secuencia verde→rojo(test roto)→verde confirmada con `gh` · criterios 2/2 · nota no bloqueante: `actions/checkout@v4`+`setup-node@v4` avisan deprecación Node 20 (migrar a v5 a futuro) |
| ISSUE-05 Modelo de datos de personas | ✅ Completado | impl · review (Lead) OK | PR #4 · mergeado a `main` (2026-07-14) · 34 tests locales verdes + 3 de constraints en CI (email dup → P2002, borrar Family con perfiles → P2003 sin huérfanos, round-trip de migración) · criterios 2/2 · schema/migración coherentes con FK `onDelete: Restrict` |
| ISSUE-06 … ISSUE-34 | ⚪ Pendiente | — | ver cuerpos abajo; respetar `Depende de:` |

---

## Milestone 0 — Fundaciones del repo

### ISSUE-01: Scaffolding del backend
**Spec:** §2, §3 · **Depende de:** —
Crear el esqueleto del repo backend: TypeScript estricto, Fastify, Prisma inicializado apuntando a PostgreSQL, estructura modular `src/modules/{auth,families,catalog,progress,gamification,admin}`, `src/plugins/`, `tests/`. Tooling: Vitest, ESLint + Prettier, scripts `dev`, `test`, `build`, `lint`.
**Criterios de aceptación:**
- `npm run dev` levanta el servidor y `GET /api/v1/health` responde `{ data: { status: "ok" } }`.
- `npm test` corre un test de integración del health check contra la app real.
- La estructura de módulos existe con un README de una línea por módulo indicando su responsabilidad.

### ISSUE-02: Entorno local con Docker Compose
**Spec:** §3 · **Depende de:** ISSUE-01
`docker-compose.dev.yml` con PostgreSQL (volumen persistente, sin puerto expuesto salvo localhost) y base de datos separada para tests. Configuración por variables de entorno validadas al arranque (el servidor **no inicia** si falta una variable requerida; lista exacta en `.env.example`).
**Criterios de aceptación:**
- `docker compose -f docker-compose.dev.yml up -d` + `npm run dev` funciona de cero en una máquina limpia.
- Arrancar sin `DATABASE_URL` termina el proceso con mensaje claro, no con stack trace.
> Nota (de ISSUE-01): `prisma validate` requiere `DATABASE_URL` en el entorno — sin ella falla con `P1012`. Incluir `DATABASE_URL` en `.env.example`.

### ISSUE-03: Convenciones transversales de API
**Spec:** §5 (Convenciones), §6 (errores/logs) · **Depende de:** ISSUE-01
Plugin de Fastify que impone: prefijo `/api/v1`, envelope `{ data }` / `{ error: { code, message } }`, catálogo tipado de códigos de error (`ErrorCode` union: `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `FAMILY_SUSPENDED`, `INVALID_PIN`, `RATE_LIMITED`, `INTERNAL`), logging estructurado (pino) con **ID de correlación** generado por request y devuelto en header `x-request-id` y en el body de error.
**Criterios de aceptación:**
- Un error lanzado en cualquier handler produce `{ error: { code, message, requestId } }` sin stack trace ni SQL en el body.
- El log del servidor contiene el detalle completo bajo el mismo `requestId`.
- Test de integración cubre: error de validación, error interno, y formato de éxito.

### ISSUE-04: CI en GitHub Actions
**Spec:** §7 · **Depende de:** ISSUE-02
Workflow que en cada push/PR: instala dependencias, levanta PostgreSQL (service container), corre migraciones, `lint` y `test`.
**Criterios de aceptación:**
- El workflow pasa en verde en el repo.
- Un test roto hace fallar el workflow (verificado una vez y revertido).
> Nota (de ISSUE-01): el workflow debe exportar `DATABASE_URL` en el entorno antes de correr cualquier comando `prisma` (validate/migrate); de lo contrario falla con `P1012`.

---

## Milestone 1 — Autenticación y familias

### ISSUE-05: Modelo de datos de personas
**Spec:** §4 (Personas) · **Depende de:** ISSUE-02
Migración Prisma: `User` (id, email único, passwordHash, role `admin|parent`), `Family` (id, name, status `active|suspended`, adminNote nullable, parentUserId), `StudentProfile` (id, familyId, name, avatar, pinHash, gradeId nullable, failedPinAttempts, pinLockedUntil nullable).
**Criterios de aceptación:**
- Migración aplica y revierte limpiamente.
- Tests de constraints: email duplicado falla; borrar Family no huérfana StudentProfiles (FK con restricción explícita).

### ISSUE-06: Login de padre/admin
**Spec:** §5 (Auth), §6 · **Depende de:** ISSUE-03, ISSUE-05
`POST /auth/login` con email + contraseña. Hash argon2id. Devuelve access token JWT (15 min, claims: userId, role, familyId si aplica) + refresh token opaco persistido (hasheado) con expiración.
**Criterios de aceptación:**
- Credenciales válidas → tokens; inválidas → `UNAUTHORIZED` con el **mismo mensaje** exista o no el email (sin enumeración de usuarios).
- El access token expira a los 15 minutos (test con clock falso).
> Nota (de review-agent, ISSUE-03): Fastify usa `ajv` con `coerceTypes: true` por defecto, así que un `type: "string"`/`"number"` **no rechaza tipos incorrectos, los coacciona**. Validar IDs/credenciales con `format`/`pattern`, no solo `type`. Decidir antes de Milestone 1.

### ISSUE-07: Refresh con rotación
**Spec:** §5 (Auth), §6 · **Depende de:** ISSUE-06
`POST /auth/refresh`: valida el refresh token, emite par nuevo e **invalida el anterior**. Reuso de un refresh token ya rotado revoca toda la cadena de esa sesión (detección de robo).
**Criterios de aceptación:**
- Refresh válido → tokens nuevos; el anterior deja de servir.
- Reusar un token rotado → `UNAUTHORIZED` y todos los refresh de esa sesión quedan revocados (test).

### ISSUE-08: Sesión de alumno por PIN
**Spec:** §2 (Alumnos), §5 (Auth), §6 · **Depende de:** ISSUE-06
`POST /auth/student-session`: requiere sesión de padre; recibe studentProfileId + PIN (4 dígitos, hasheado). Emite token limitado (claims: studentProfileId, familyId, role `student`, 15 min). Límite de intentos: 5 fallos → bloqueo del PIN 15 min (`INVALID_PIN` incluye si está bloqueado, sin revelar cuántos intentos quedan).
**Criterios de aceptación:**
- PIN correcto de un hijo propio → token de alumno.
- PIN de un perfil de **otra familia** → `FORBIDDEN` (pertenencia verificada contra BD).
- 5 fallos consecutivos bloquean; el contador se resetea con un acierto tras el desbloqueo.
> Nota (de review-agent, ISSUE-03): por `coerceTypes: true` de `ajv`, validar el PIN con `pattern: "^[0-9]{4}$"` (y los IDs con `format`/`pattern`), no con `type: "string"` a secas — de lo contrario tipos incorrectos se coaccionan en vez de rechazarse. Decidir antes de Milestone 1.

### ISSUE-09: Autorización por rol y pertenencia
**Spec:** §6 · **Depende de:** ISSUE-06, ISSUE-08
Decoradores/hooks reutilizables: `requireRole('admin'|'parent'|'student')` y verificación de pertenencia (padre→sus hijos, alumno→su propio perfil) **consultando la BD**, no solo los claims del token.
**Criterios de aceptación:**
- Token de alumno llamando un endpoint de padre → `FORBIDDEN`.
- Padre pidiendo el progreso de un hijo ajeno → `FORBIDDEN` aunque el ID exista.
- Suite de tests de matriz rol×endpoint que los issues posteriores extienden al agregar rutas.

### ISSUE-10: Suspensión de familia efectiva de inmediato
**Spec:** §5 (Suspensión), §6 · **Depende de:** ISSUE-09
El hook de autenticación consulta `Family.status` en cada request autenticado de padre/alumno: si `suspended`, responde `FAMILY_SUSPENDED` aunque el token siga vigente. No se borra ningún dato. La racha durante suspensión se pierde como cualquier inactividad (default del spec).
**Criterios de aceptación:**
- Suspender una familia corta el acceso de padre e hijos en el siguiente request (test con token aún válido).
- Reactivar restaura acceso; progreso, XP e insignias intactos.

### ISSUE-11: Rate limiting
**Spec:** §6 · **Depende de:** ISSUE-06, ISSUE-08
`@fastify/rate-limit`: límite estricto en `/auth/login` y `/auth/student-session` (p. ej. 10/min por IP) y límite global por IP. Respuesta `RATE_LIMITED`.
**Criterios de aceptación:**
- Exceder el límite en login devuelve `RATE_LIMITED` y no toca la BD (test).

---

## Milestone 2 — Catálogo y panel admin (API)

### ISSUE-12: Modelo de datos del catálogo
**Spec:** §4 (Catálogo, Preguntas extensibles) · **Depende de:** ISSUE-05
Migración Prisma: `Grade`, `Week` (gradeId, number, title, description), `Lesson` (weekId, order, type `video|reading|quiz`, campos por tipo: embedUrl / contenido rico o fileKey R2), `Question` (lessonId, order, type `multiple_choice|true_false|fill_blank`, content JSON, answerSpec JSON, points), `Topic` y tablas de etiquetado Lesson↔Topic y Question↔Topic.
**Criterios de aceptación:**
- Constraint: `Question` solo puede colgar de `Lesson` tipo `quiz` (validado en capa de servicio con test).
- `order` único por semana (lecciones) y por lección (preguntas).

### ISSUE-13: CRUD de grados y semanas
**Spec:** §5 (Admin) · **Depende de:** ISSUE-09, ISSUE-12
`CRUD /admin/grades` y `/admin/weeks` (solo rol admin). Borrado de un grado/semana con contenido → rechazo con error explícito (sin borrados en cascada silenciosos).
**Criterios de aceptación:**
- CRUD completo con validación JSON Schema por operación.
- No-admin → `FORBIDDEN` (extiende la matriz de ISSUE-09).

### ISSUE-14: CRUD de lecciones y reordenamiento
**Spec:** §5 (Admin) · **Depende de:** ISSUE-13
`CRUD /admin/lessons` con payload según `type` (video: embedUrl; lectura: contenido o fileKey; quiz: se crea vacío y las preguntas van por ISSUE-15). `POST /admin/lessons/reorder` recibe la lista ordenada de IDs de una semana y la aplica atómicamente.
**Criterios de aceptación:**
- Crear lección de cada tipo con su payload correcto; payload de tipo cruzado → `VALIDATION_ERROR`.
- Reorder con un ID de otra semana → rechazo total (transacción, nada parcial).

### ISSUE-15: CRUD de preguntas con validación por tipo
**Spec:** §4 (Preguntas extensibles), §5 (Admin) · **Depende de:** ISSUE-14
`CRUD /admin/questions`. Registro de **tipos de pregunta** (`questionTypeRegistry`): cada tipo declara el JSON Schema de su `content` y de su `answerSpec`. v1 registra `multiple_choice`, `true_false`, `fill_blank`. Este registro es el punto de extensión para tipos futuros (numérico, operaciones generadas) — agregar un tipo = registrar schemas + validador, **cero migraciones**.
**Criterios de aceptación:**
- Crear pregunta de cada tipo v1 con content/answerSpec válidos; inválidos → `VALIDATION_ERROR` indicando el campo.
- Test que registra un tipo ficticio en el registry y verifica que el CRUD lo acepta sin cambios de esquema (prueba del punto de extensión).

### ISSUE-16: Topics y etiquetado
**Spec:** §4 (Topics transversales) · **Depende de:** ISSUE-15
`CRUD /admin/topics` y endpoints para etiquetar/desetiquetar lecciones y preguntas con topics.
**Criterios de aceptación:**
- Una pregunta puede tener varios topics; borrar un topic en uso → rechazo explícito.

### ISSUE-17: Subida de archivos a R2 con URL firmada
**Spec:** §3, §5 (uploads) · **Depende de:** ISSUE-09
`POST /admin/uploads`: valida tipo de archivo permitido (pdf, png, jpg, webp) y tamaño máximo declarado; devuelve URL firmada de subida directa a R2 (S3 API) + `fileKey`. El archivo **nunca pasa por el VPS**. Lectura: URLs públicas de R2 o firmadas de lectura según config.
**Criterios de aceptación:**
- Mock de R2 en tests: extensión no permitida → `VALIDATION_ERROR`; permitida → URL firmada con expiración corta y `fileKey` con prefijo por tipo.

### ISSUE-18: Gestión de familias y overview
**Spec:** §2 (registro cerrado, bloqueo manual), §5 (Admin) · **Depende de:** ISSUE-10
`CRUD /admin/families` (crear familia = crear User padre con contraseña temporal + Family; crear perfiles de alumnos con PIN inicial), `POST /admin/families/:id/suspend` (nota opcional, p. ej. "pendiente pago julio"), `POST /admin/families/:id/reactivate`, `GET /admin/overview` (familias activas/suspendidas, alumnos con actividad en los últimos 7 días).
**Criterios de aceptación:**
- Flujo completo: admin crea familia → padre hace login con credencial temporal → crea sesión de alumno (test de integración end-to-end).
- Suspend/reactivate reflejan el comportamiento ya probado en ISSUE-10 vía estos endpoints.

---

## Milestone 3 — Experiencia del alumno: progreso y gamificación

### ISSUE-19: Modelo de datos de progreso y juego
**Spec:** §4 (Progreso y juego) · **Depende de:** ISSUE-12
Migración Prisma: `LessonProgress` (studentProfileId × lessonId único, completedAt), `QuizAttempt` (studentProfileId, lessonId, answers JSON, score, maxScore, createdAt), `XPEvent` (studentProfileId, amount, reason enum, refId, createdAt — **solo inserción, nunca update/delete**), `Streak` (studentProfileId, current, longest, lastActivityDate), `Badge` (code único, name, description, criteria JSON), `BadgeAward` (studentProfileId × badgeId único, awardedAt), `TopicMastery` (studentProfileId × topicId único, level enum `attempted|familiar|proficient|mastered`, updatedAt).
**Criterios de aceptación:**
- Constraints de unicidad verificadas por test.
- No existe ninguna ruta ni servicio que edite o borre `XPEvent` (test de arquitectura: el módulo solo exporta `append` y consultas).

### ISSUE-20: Camino del alumno
**Spec:** §5 (GET /me/path) · **Depende de:** ISSUE-16, ISSUE-19
`GET /me/path` (rol alumno): semanas del grado asignado con sus lecciones en orden, estado por lección (`locked|available|completed`). Regla de desbloqueo v1: las lecciones de una semana se desbloquean en orden; la semana N+1 se desbloquea al completar la semana N. Una sola query eficiente (sin N+1).
**Criterios de aceptación:**
- Alumno nuevo: solo la primera lección de la semana 1 `available`.
- Completar lecciones va desbloqueando en orden (test de integración con datos sembrados).
- Sin grado asignado → error claro `NOT_FOUND` con mensaje accionable.

### ISSUE-21: Contenido de lección sin respuestas
**Spec:** §5, §6 · **Depende de:** ISSUE-20
`GET /lessons/:id` (alumno, con lección desbloqueada): contenido según tipo. Para quiz: preguntas con `content` pero **jamás** `answerSpec`. Lección bloqueada → `FORBIDDEN`.
**Criterios de aceptación:**
- Test que serializa la respuesta de un quiz y asegura que `answerSpec` no aparece en ningún nivel del JSON.

### ISSUE-22: Completar video/lectura
**Spec:** §5 (POST /lessons/:id/complete) · **Depende de:** ISSUE-20, ISSUE-25
`POST /lessons/:id/complete` (alumno; solo tipos video/lectura, desbloqueadas): registra `LessonProgress`, emite `XPEvent` (+10), actualiza racha, evalúa insignias. **Idempotente**: repetir la llamada no duplica XP ni progreso. Devuelve `{ xpEarned, totalXp, level, streak, newBadges }`.
**Criterios de aceptación:**
- Segunda llamada → misma respuesta con `xpEarned: 0`, sin nuevo `XPEvent` (test).
- Sobre una lección tipo quiz → `VALIDATION_ERROR`.

### ISSUE-23: Motor de calificación por tipo de pregunta
**Spec:** §4 (validación server-side) · **Depende de:** ISSUE-15
Módulo puro `grading`: para cada tipo del `questionTypeRegistry`, una función `grade(answerSpec, studentAnswer) → { correct, pointsEarned }`. Implementar los tres tipos v1 (fill_blank: comparación normalizada — trim, case-insensitive, acentos según flag en answerSpec). Sin tocar HTTP ni BD: funciones puras con tests unitarios exhaustivos.
**Criterios de aceptación:**
- Suite unitaria por tipo cubriendo respuesta correcta, incorrecta, malformada (→ incorrecta, nunca excepción) y casos límite de normalización.
- Registrar un tipo nuevo con su `grade` no requiere tocar ningún archivo existente salvo el registro (test del punto de extensión).

### ISSUE-24: Enviar intento de quiz
**Spec:** §5 (POST /quizzes/:id/attempts) · **Depende de:** ISSUE-21, ISSUE-23, ISSUE-25, ISSUE-26, ISSUE-27, ISSUE-28
`POST /quizzes/:id/attempts` (alumno, quiz desbloqueado): califica con el motor de grading, persiste `QuizAttempt` completo (qué se preguntó, qué respondió), marca `LessonProgress` si aprueba (≥70% v1, constante configurable), emite XP (+20 aprobado, +5 intento no aprobado — solo el primer intento no aprobado del día por quiz), actualiza racha, insignias y maestría. Devuelve `{ score, maxScore, passed, perQuestion: [{questionId, correct}], xpEarned, streak, newBadges, masteryChanges }`.
**Criterios de aceptación:**
- Test de integración end-to-end: sembrar quiz → responder mixto → verificar cada campo de la respuesta y cada fila persistida.
- `perQuestion` indica correcto/incorrecto **sin revelar la respuesta correcta**.
- Reintentos permitidos; el XP no es farmeable (reglas de arriba, test).

### ISSUE-25: Motor de XP y niveles
**Spec:** §4 (XPEvent, libro de eventos) · **Depende de:** ISSUE-19
Servicio `xp`: `append(studentId, amount, reason, refId)` idempotente por `(reason, refId)`, `getTotal(studentId)`, `getLevel(totalXp)` con curva v1: nivel N requiere `100 × N × (N+1) / 2` XP acumulado (constante documentada, ajustable sin migración).
**Criterios de aceptación:**
- Unitarios de la curva (límites exactos entre niveles).
- Idempotencia: mismo `(reason, refId)` dos veces → un solo evento.

### ISSUE-26: Rachas
**Spec:** §4 (Streak), §7 (zonas horarias) · **Depende de:** ISSUE-19
Servicio `streak.recordActivity(studentId, timezone)`: usa la **zona horaria de la familia** (campo `timezone` en Family, default configurable; agregarlo aquí con migración). Mismo día → sin cambio; día siguiente → +1; brecha ≥1 día → reinicia a 1. Actualiza `longest`.
**Criterios de aceptación:**
- Unitarios con clock falso: actividad 23:59 y 00:01 del día siguiente cuenta como 2 días; dos actividades el mismo día local cuentan 1; cruce de medianoche UTC vs. local cubierto.

### ISSUE-27: Insignias
**Spec:** §4 (Badge/BadgeAward) · **Depende de:** ISSUE-25, ISSUE-26
Evaluador de insignias por eventos: tras cada actividad se evalúan criterios declarativos (JSON `criteria`). Set v1: `first-lesson` (primera lección), `week-complete` (una semana entera), `perfect-quiz` (100%), `streak-7` y `streak-30`. Otorgamiento idempotente (única por alumno).
**Criterios de aceptación:**
- Test por insignia: se otorga exactamente cuando corresponde, una sola vez.
- Agregar una insignia nueva al catálogo puede otorgarse retroactivamente recorriendo el historial de eventos (test con `streak-7` agregada después de los hechos… usando `longest`).

### ISSUE-28: Maestría por topic
**Spec:** §4 (TopicMastery) · **Depende de:** ISSUE-19, ISSUE-23
Servicio `mastery.recalculate(studentId, topicIds)` tras cada quiz: considera las respuestas a preguntas etiquetadas con el topic en los **últimos 10 intentos** que lo toquen. Umbrales v1: `attempted` (≥1 respuesta), `familiar` (≥60% de aciertos con ≥5 respuestas), `proficient` (≥80% con ≥10), `mastered` (≥95% con ≥15). Constantes documentadas y ajustables. El nivel puede bajar si el desempeño reciente cae.
**Criterios de aceptación:**
- Unitarios por umbral, incluyendo descenso de nivel.
- Un quiz con preguntas de 3 topics actualiza los 3 (test de integración).

### ISSUE-29: Resumen del alumno
**Spec:** §5 (GET /me/summary) · **Depende de:** ISSUE-25, ISSUE-26, ISSUE-27, ISSUE-28
`GET /me/summary`: XP total, nivel y progreso hacia el siguiente, racha actual y récord, insignias (ganadas y por ganar), maestría por topic.
**Criterios de aceptación:**
- Test de integración con historial sembrado verificando cada bloque del payload.

### ISSUE-30: Endpoints del padre
**Spec:** §5 (Padre) · **Depende de:** ISSUE-29
`GET /family/students` (hijos con resumen compacto) y `GET /family/students/:id/progress` (avance por semana, maestría, racha, últimos intentos). Pertenencia verificada (reutiliza ISSUE-09).
**Criterios de aceptación:**
- Padre ve exactamente a sus hijos; hijo ajeno → `FORBIDDEN`.

---

## Milestone 4 — Despliegue y operación

### ISSUE-31: Imagen de producción y compose del VPS
**Spec:** §3 (infra VPS) · **Depende de:** ISSUE-04
`Dockerfile` multi-stage (build TS → imagen slim, usuario no root) y `docker-compose.prod.yml`: Caddy (HTTPS automático, único servicio con puertos publicados 80/443), API, PostgreSQL solo en red interna con volumen. `Caddyfile` con reverse proxy y headers de seguridad (HSTS, nosniff, frame-deny).
**Criterios de aceptación:**
- `docker compose -f docker-compose.prod.yml up` local sirve la API detrás de Caddy; el puerto de PostgreSQL no es alcanzable desde fuera de la red de Docker (test manual documentado).

### ISSUE-32: Backups automáticos a R2
**Spec:** §3, §6 (backups) · **Depende de:** ISSUE-31
Contenedor/cron de backup: `pg_dump` diario, cifrado simétrico (age o gpg, llave fuera del VPS), subida a bucket R2 con retención 30 días (lifecycle rule). Script `restore.sh` + runbook `docs/runbooks/restore.md` con el procedimiento y el recordatorio de **prueba de restauración mensual**.
**Criterios de aceptación:**
- Ciclo completo probado contra un bucket de prueba: dump → cifra → sube → descarga → descifra → restaura en una BD vacía → la API arranca contra ella.

### ISSUE-33: Hardening del VPS
**Spec:** §3, §6 · **Depende de:** ISSUE-31
Script idempotente de aprovisionamiento (`provision.sh`) + runbook: firewall (ufw: solo 22 limitado, 80, 443), SSH solo por llave y sin root login, `unattended-upgrades`, fail2ban para SSH, Docker instalado. Documentar en `docs/runbooks/vps-setup.md`.
**Criterios de aceptación:**
- Ejecutado sobre un VPS limpio deja el checklist del runbook 100% verificable (cada ítem con su comando de verificación y salida esperada).

### ISSUE-34: Pipeline de deploy
**Spec:** §7 (CI, nada llega al VPS sin verde) · **Depende de:** ISSUE-31, ISSUE-33
Job de GitHub Actions en push a `main`: **solo si los tests pasan**, construye la imagen, la publica (GHCR) y despliega al VPS (SSH: pull + `docker compose up -d` + migraciones Prisma + health check post-deploy; si el health check falla, alerta y no se marca exitoso).
**Criterios de aceptación:**
- Deploy end-to-end demostrado: un cambio trivial llega a producción solo tras tests en verde, con health check verificado.

---

## Backlog v2 (fuera de alcance — spec §8; no implementar)

- `[v2]` Pasarela de pagos / suscripciones automáticas (hoy: suspensión manual, ISSUE-18).
- `[v2]` Registro abierto de familias.
- `[v2]` Ranking/ligas (decidir privacidad entre familias antes de diseñar).
- `[v2]` Tareas con entrega y calificación manual.
- `[v2]` Tipos de pregunta interactivos: numérico, operaciones matemáticas generadas, arrastrar — el punto de extensión ya queda probado en ISSUE-15 e ISSUE-23.
- `[v2]` Video hosting protegido (Mux o similar).
- `[v2]` Notificaciones push de recordatorio de racha (se diseña con el repo mobile).

---

## Matriz de trazabilidad spec → issues

| Sección del spec | Issues |
|---|---|
| §2 Decisiones (stack, registro cerrado, alumnos por PIN) | 01, 06, 08, 18 |
| §3 Arquitectura e infra VPS | 01, 02, 17, 31, 32, 33 |
| §4 Personas | 05 |
| §4 Catálogo y Topics | 12, 13, 14, 16 |
| §4 Preguntas extensibles | 15, 23 |
| §4 Progreso y juego (libro de eventos) | 19, 25, 26, 27, 28 |
| §5 Convenciones API | 03 |
| §5 Autenticación | 06, 07, 08 |
| §5 Endpoints alumno | 20, 21, 22, 24, 29 |
| §5 Endpoints padre | 30 |
| §5 Endpoints admin | 13, 14, 15, 16, 17, 18 |
| §5 Suspensión manual | 10, 18 |
| §6 Seguridad | 03, 06, 07, 08, 09, 10, 11, 21, 31, 32, 33 |
| §7 Testing y CI | 04, 34 + DoD de todos los issues |
| §8 Fuera de alcance | Backlog v2 |
