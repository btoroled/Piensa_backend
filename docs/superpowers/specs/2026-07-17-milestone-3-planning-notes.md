# Milestone 3 — Notas de planificación (decisiones anticipadas)

Decisiones tomadas durante la planificación de Milestone 2 que aplican a Milestone 3. **No implementar ahora**; recogerlas cuando planifiquemos M3 (motor de corrección, XP, progreso).

---

## Follow-up: bloque de actividad de `GET /admin/overview` (viene de ISSUE-18)

**Origen:** en Milestone 2 se recortó de ISSUE-18 la métrica "alumnos con actividad en los últimos 7 días", porque los datos de actividad (`LessonProgress`, `XPEvent`, `Streak`) nacen en ISSUE-19 (este milestone), posterior a ISSUE-18.

**A hacer en M3:** una vez exista el progreso, agregar al `GET /admin/overview` el bloque de "alumnos activos en los últimos 7 días" (y lo que haga falta del panel de operación). Es un follow-up chico sobre un endpoint que ya existe; consume las tablas de progreso de ISSUE-19.

---

## Tipo de pregunta "desarrollo" (respuesta abierta) — corrección por similitud semántica

**Origen:** idea del usuario durante la decisión del registro de tipos de pregunta (ISSUE-15).

**Estado:** extensión **más allá de v1** (el spec §8 mantiene los tipos interactivos/abiertos como v2). Queda **habilitada por el registro de tipos** de ISSUE-15: agregar este tipo = registrar sus schemas + su corrector, **cero migraciones**. Se construye dentro del motor de corrección (ISSUE-23) o posterior, **no en Milestone 2**. En M2 el catálogo solo registra los 3 tipos v1 (opción múltiple, V/F, completar).

### Decisiones ya tomadas

- **Privacidad → modelo LOCAL, no API externa.** No usar Gemini ni ninguna API de terceros para corregir. Se procesa con un **modelo local corriendo en nuestros propios servidores**, porque son respuestas de **menores** y no debe salir data de chicos a un tercero. (Coherente con "siempre la opción más segura".)

- **Enfoque técnico:** modelo local de **embeddings** (p. ej. un sentence-transformer multilingüe) → **similitud coseno** entre la respuesta del alumno y la respuesta de referencia guardada en `answerSpec`. Beneficio extra: es **determinista** (misma respuesta → misma nota), así que es testeable con fixtures y no farmeable por azar (a diferencia de un LLM generativo).

- **Reglas de XP por % de similitud:**
  - **≥ 90%** → XP **completa** (respuesta correcta)
  - **≥ 50% y < 90%** → XP **parcial**
  - **< 50%** → **error** (incorrecta)
  - Umbrales **documentados y ajustables** (mismo estilo que las demás constantes del spec).

- **Disponibilidad:** al ser local, depende de **nuestros propios servidores**, no de un tercero. Aun así, definir un fallback si el servicio de embeddings no está disponible (dejar el intento "pendiente"/reintentar), para que la corrección nunca quede colgada.

- **`answerSpec`:** guarda la respuesta de referencia + los umbrales; **nunca se serializa al cliente** (igual que el resto de los tipos, ISSUE-21).

### A resolver cuando planifiquemos M3

- Elegir el modelo local concreto y **dónde corre** (mismo proceso, sidecar/contenedor aparte, cola de trabajo) y su costo de infra en el VPS.
- Cómo encaja la **XP parcial** en el motor de XP (ISSUE-24/25): hoy las reglas v1 son +20 aprobado / +5 primer intento no aprobado del día. "Parcial" es un caso nuevo — definir cuánta XP y si cuenta como aprobado para el progreso de la lección.
- Integración con el registro de corrección: el corrector recibe un **"embedder" inyectable** para poder testear con stub (sin cargar el modelo real en CI), manteniendo el resto de los correctores como funciones puras.
- Manejo del intento "pendiente" en el flujo de `QuizAttempt` si el corrector es asíncrono.
