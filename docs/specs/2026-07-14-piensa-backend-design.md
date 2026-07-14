# Piensa Homeschool — Diseño del Backend

**Fecha:** 2026-07-14
**Estado:** Aprobado en sesión de brainstorming
**Alcance:** Backend (repo 1 de 3). Frontend web (React + Tailwind) y Mobile (React Native) se diseñan aparte y consumen esta misma API.

## 1. Contexto y objetivo

Hoy la operación corre sobre Moodle con ~20 familias clientes que pagan por la administración del portal y la carga continua de contenido. Se construye una plataforma propia para:

- **Masificar**: pasar de decenas a cientos/miles de familias sin rehacer nada.
- **Gamificar**: experiencia estilo Duolingo (camino semanal) con maestría por tema estilo Khan Academy.
- **No duplicar trabajo al codear**: una sola API alimenta web y mobile; la lógica vive una sola vez en el backend.

El contenido de Moodle se recargará a mano en la nueva plataforma (sin importador). No hay migración de historial.

## 2. Decisiones principales

| Decisión | Elección | Razón |
|---|---|---|
| Arquitectura | Monolito modular | Más barato de operar y menor superficie de ataque; escala de sobra para esta etapa |
| Stack | Node.js + TypeScript, Fastify, Prisma, PostgreSQL | Mismo lenguaje que web y mobile; validación nativa por JSON Schema |
| Hosting | VPS autoadministrado (Hetzner CX22 o similar, ~€5/mes) con Docker Compose | Control total al costo mínimo |
| Archivos | Cloudflare R2 (PDFs, imágenes) con URLs firmadas de subida | Sin costo de egreso; los archivos no pasan por el VPS |
| Videos | Embed de YouTube (no listado) / Vimeo en v1 | Costo cero; se puede integrar Mux después sin cambiar el modelo |
| Pagos | Fuera de la plataforma en v1 | El admin suspende/reactiva familias manualmente |
| Registro | Cerrado en v1 | Solo el admin crea familias (coherente con cobro manual) |
| Alumnos | Sin email/contraseña; perfil + PIN dentro de la cuenta del padre (estilo Netflix Kids) | Mínimos datos personales de menores |

## 3. Arquitectura

```
Web (React)        Mobile (React Native)
     └──────────┬──────────┘
                ▼ HTTPS
        API REST /api/v1 (Fastify + TS)
   ┌─────────────────────────────────────┐
   │ auth │ families │ catalog           │
   │ progress │ gamification │ admin     │
   └──────────────┬──────────────────────┘
        ┌─────────┴─────────┐
        ▼                   ▼
   PostgreSQL          Cloudflare R2
```

- Un repo, un deploy. Módulos internos con límites claros: cada módulo tiene sus rutas, servicios y acceso a datos propios. Si un módulo crece, puede extraerse a futuro.
- ORM Prisma con migraciones versionadas.
- El panel de administración **no es un repo aparte**: vive en el frontend web como sección `/admin` protegida por rol, consumiendo esta misma API.

### Infraestructura en el VPS (Docker Compose)

- **Caddy**: HTTPS automático, único punto de entrada (puertos 80/443).
- **API Fastify**: la aplicación.
- **PostgreSQL**: contenedor con volumen persistente, sin puerto expuesto a internet (solo red interna de Docker).
- **Cron de backup**: dump diario de la BD, cifrado, subido a R2, retención de 30 días. Prueba de restauración mensual.
- SSH solo por llave; `unattended-upgrades` activo; firewall solo 80/443.

## 4. Modelo de datos

### Personas

```
User (rol: admin | parent) — email + contraseña (argon2)
  └─ Family (status: active | suspended, nota del admin)
       └─ StudentProfile (nombre, avatar, PIN 4 dígitos hasheado, grado asignado)
```

### Catálogo (lo que carga el admin)

```
Grade (ej. "3° Primaria")
  └─ Week (número, título, descripción) — las "secciones" estilo Duolingo
       └─ Lesson (orden dentro de la semana; tipo: video | lectura | quiz)
            video   → URL de embed
            lectura → contenido rico o PDF en R2
            quiz    → lista de Question

Topic (ej. "Fracciones") — transversal a las semanas
  ↕ cada Lesson/Question se etiqueta con uno o más Topics
```

Los **Topics son independientes de las semanas**: la maestría del alumno se calcula por Topic acumulando su desempeño en todos los quizzes etiquetados con él, sin importar en qué semana aparezcan.

### Preguntas extensibles (decisión explícita)

```
Question
├─ type: "multiple_choice" | "true_false" | "fill_blank"   ← v1
├─ content:    JSON según el tipo (enunciado, opciones, imagen…)
└─ answerSpec: JSON según el tipo (respuesta correcta, tolerancia)
```

- La **validación siempre ocurre en el servidor**; el cliente nunca recibe la respuesta correcta. Esto evita trampas (hay XP en juego) y habilita la extensión.
- Tipos futuros (numérico, operaciones matemáticas generadas, arrastrar y soltar) se agregan como **nuevo validador en el backend + nuevo componente en los clientes, sin migración de base de datos** y sin tocar XP, maestría, rachas ni progreso, que operan sobre `QuizAttempt` y no conocen el tipo de pregunta.
- Los ejercicios generados (práctica infinita estilo Khan) usarán una plantilla generadora; cada `QuizAttempt` registra qué se preguntó y qué se respondió, así que la maestría funciona igual.

### Progreso y juego (libro de eventos, no contadores editables)

```
LessonProgress → alumno × lección: completada, fecha
QuizAttempt    → alumno × quiz: respuestas, puntaje, fecha (todos los intentos)
XPEvent        → libro mayor de XP (+10 lección, +20 quiz aprobado…);
                 el nivel se deriva del total; nunca se edita, solo se agregan eventos
Streak         → días consecutivos con actividad
Badge / BadgeAward → catálogo de insignias y otorgamientos
TopicMastery   → alumno × topic: intentado → familiar → competente → dominado;
                 recalculado tras cada quiz según aciertos recientes en el topic
```

Ventajas del libro de eventos: el XP es auditable (se sabe de dónde salió cada punto), un bug no puede "perder" puntos, y las insignias nuevas pueden otorgarse retroactivamente.

Gamificación v1: **XP y niveles, rachas, insignias, maestría por topic**. Sin ranking/ligas (decisión explícita, evaluar en v2 por privacidad entre familias).

## 5. API

### Convenciones

- Prefijo `/api/v1`. Versionado desde el día 1 para no romper apps móviles instaladas.
- JWT access (15 min) + refresh token rotativo. Cada endpoint declara roles admitidos.
- Formato único de respuesta: `{ data }` o `{ error: { code, message } }`.
- Códigos de error estables (`FAMILY_SUSPENDED`, `INVALID_PIN`, …); los clientes deciden por código, nunca parseando mensajes.

### Autenticación

```
POST /auth/login            email + contraseña (padre o admin)
POST /auth/refresh
POST /auth/student-session  perfil de hijo + PIN → token limitado rol "alumno"
```

### Alumno

```
GET  /me/path               camino completo del grado: semanas, lecciones,
                            estado (completado/desbloqueado). Una llamada
                            pinta la pantalla principal.
GET  /lessons/:id           contenido (sin respuestas correctas)
POST /lessons/:id/complete  marca video/lectura → devuelve XP ganado
POST /quizzes/:id/attempts  califica en servidor → devuelve puntaje, XP,
                            racha, insignias nuevas y cambios de maestría
GET  /me/summary            XP, nivel, racha, insignias, maestría por topic
```

Las respuestas de completar/quiz incluyen las recompensas para que la app muestre la celebración sin llamadas extra.

### Padre

```
GET /family/students                    hijos y resumen de cada uno
GET /family/students/:id/progress       avance semanal, maestría, rachas
```

### Admin

```
CRUD /admin/grades | weeks | lessons | questions | topics | badges
POST /admin/lessons/reorder             ordenar el camino
CRUD /admin/families                    crear familia y perfiles de alumnos
POST /admin/families/:id/suspend        con nota (ej. "pendiente pago julio")
POST /admin/families/:id/reactivate
GET  /admin/overview                    familias activas, alumnos activos
POST /admin/uploads                     URL firmada → subida directa a R2
```

### Suspensión manual (requisito de negocio)

- El admin cambia `Family.status` a `suspended` con nota opcional.
- El middleware de autenticación consulta el estado de la familia: la suspensión aplica de inmediato aunque existan tokens vigentes; padres y alumnos reciben `FAMILY_SUSPENDED` con mensaje amable.
- No se borra nada: progreso, XP e insignias quedan intactos al reactivar. (Detalle pendiente para implementación: si la racha se congela o se pierde durante la suspensión; por defecto se pierde como cualquier inactividad.)

## 6. Seguridad

- Contraseñas con argon2; PINs hasheados con límite de intentos.
- Autorización por rol **y pertenencia** en cada endpoint, verificada contra la BD (un padre solo ve sus hijos; un token de alumno solo toca su propio perfil).
- Validación de entrada con JSON Schema en todas las rutas; Prisma parametriza todo (sin inyección SQL).
- Rate limiting en login/student-session y global por IP.
- Mensajes de error sin detalles internos; logs estructurados en servidor con ID de correlación que también recibe el cliente.
- VPS endurecido según §3 (firewall, SSH por llave, BD sin exponer, HTTPS forzado, parches automáticos, backups cifrados probados).

## 7. Testing

- **Integración sobre la API real** con PostgreSQL de prueba: cada endpoint probado como lo usarán web y mobile; un solo set de tests protege a los tres repos.
- **Unitarios concentrados en la lógica de juego**: XP/niveles, rachas (zonas horarias, casos límite de medianoche), maestría, insignias y validadores por tipo de pregunta.
- Desarrollo con **TDD**: test primero, implementación después.
- **CI en GitHub Actions**: los tests corren en cada push; nada se despliega sin pasar en verde.

## 8. Fuera de alcance de v1 (explícito)

- Pasarela de pagos / suscripciones automáticas.
- Registro abierto de familias.
- Ranking/ligas entre alumnos.
- Tareas con entrega y calificación manual.
- Importador desde Moodle.
- Tipos de pregunta interactivos (numérico, operaciones generadas, arrastrar) — habilitados por el diseño, no implementados en v1.
- Video hosting propio (Mux o similar).
- Notificaciones push de recordatorio de racha (requiere apps publicadas; se diseña con el repo mobile).
