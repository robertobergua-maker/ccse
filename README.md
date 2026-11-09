# Preparación CCSE

Aplicación web con simulacros basados en las 300 preguntas del Manual CCSE 2025.

## Reglas del simulacro

- 25 preguntas y 45 minutos.
- Apto con 15 respuestas correctas.
- Tarea 1: 10 preguntas.
- Tarea 2: 3 preguntas de verdadero/falso.
- Tarea 3: 2 preguntas.
- Tarea 4: 3 preguntas.
- Tarea 5: 7 preguntas.
- La selección mantiene el reparto oficial por tareas y valida el formato:
  tareas 1, 3, 4 y 5 con tres opciones; tarea 2 de verdadero/falso con dos opciones.
- Dentro de cada tarea se priorizan las preguntas que menos han salido y las
  preguntas más falladas por el alumno.
- Cada usuario puede revisar todos sus exámenes guardados desde el historial.
  La revisión muestra solo los fallos y usa `explicacion_facil` para explicar
  el concepto con lenguaje claro.

## Modelo de datos

### `questions/{questionId}`

Cada documento se importa desde `preguntas.json` y contiene:

- `id` y `code`: código oficial único.
- `question_text`: enunciado.
- `options`: lista de objetos `{ key, text }`.
- `correct_answer`: clave de la opción correcta.
- `explicacion_facil`: explicación pedagógica en español sencillo para revisar
  fallos, pensada para alumnos extranjeros de nivel A2-B1.
- `question_type`, `task_number`, `topic`, `active` y `source`.

### `exams/{examId}`

Resumen de cada examen: usuario, fecha, preguntas incluidas, puntuaciones,
distribución por tareas y resultado apto/no apto.

### `exam_answers/{examId_questionId}`

Una fila por pregunta presentada, incluida si quedó sin responder.

### `registration_requests/{email}`

Solicitudes de acceso enviadas desde `login.html` (una por correo, el ID es el
correo en minúsculas). Las crea cualquier visitante; solo el admin las lee y
gestiona. Al aprobar una solicitud el panel genera un código `SOL-XXXXXXXX`
(un solo uso) y lo guarda en `invite_code`; el admin lo envía por correo
(botón «Enviar por correo»). Estados: `pending`, `approved`, `rejected`.

### Altas y términos

`users/{uid}` guarda `terms_accepted_at` y `terms_version`; las reglas de
Firestore exigen ambos campos al crear el perfil, así que no se puede
registrar una cuenta saltándose la casilla de Términos.

### Estadísticas protegidas

`user_question_stats` solo se puede crear/incrementar (+1) junto con un examen
nuevo (`exam_id`) escrito en el mismo lote. Examen, respuestas y estadísticas
se guardan en un único `WriteBatch` atómico.

### `user_question_stats/{userId_questionId}`

Agregado por usuario y pregunta:

- `total_attempts`
- `total_correct`
- `total_incorrect`
- `last_correct`
- `last_answer`
- `last_answered_at`

El panel calcula métricas sobre preguntas únicas. El detalle combina el banco
local con estos agregados y ordena por `total_attempts` descendente.

## Regenerar y validar el banco

```powershell
python tools\extract_ccse_questions.py "C:\ruta\Manual CCSE 2025_1.pdf"
python import_questions.py --dry-run
```

Para subir las preguntas a Firestore:

```powershell
python -m pip install firebase-admin
python import_questions.py --credentials gcp-creds.json
```

Las credenciales de cuenta de servicio no deben publicarse ni añadirse a Git.

## Vigilante del Manual CCSE

El Instituto Cervantes renueva el manual (≈25 % de las 300 preguntas) sin avisar.
El workflow [`.github/workflows/ccse-manual-watch.yml`](.github/workflows/ccse-manual-watch.yml)
se ejecuta **cada lunes** (y a mano desde la pestaña *Actions*):

1. Descubre el PDF vigente en las páginas del Instituto Cervantes
   (`tools/check_ccse_manual.py`) y extrae sus 300 preguntas sin depender de
   la maquetación de un año concreto.
2. Lo compara con `preguntas.json` y clasifica las diferencias: respuesta
   correcta cambiada (crítico), pregunta sustituida, enunciado u opciones
   retocados; ignora las diferencias solo de tildes/puntuación.
3. Publica el resumen en Firestore (`manual_status/latest`) → tarjeta
   «Estado del Manual CCSE» del panel de admin, que además avisa si el
   vigilante lleva más de 10 días sin ejecutarse.
4. Envía el **informe semanal por correo**.

Nunca modifica el banco: tú decides cuándo aplicar los cambios.

### Secretos de GitHub (Settings → Secrets and variables → Actions)

| Secreto | Para qué |
| --- | --- |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | Envío del correo (Gmail: `smtp.gmail.com`, `465`, tu dirección y una *contraseña de aplicación*) |
| `MAIL_TO` | Destinatario(s), separados por comas |
| `MAIL_FROM` | Remitente (opcional) |
| `FIREBASE_SERVICE_ACCOUNT` | JSON de una cuenta de servicio con acceso a Firestore (opcional; alimenta el panel) |

Sin un secreto, el paso correspondiente se omite con un aviso.

### Cuando haya un manual nuevo

```powershell
python tools\check_ccse_manual.py                 # informe en manual-report\report.md
python tools\extract_ccse_questions.py manual.pdf # regenera preguntas.json
python import_questions.py --dry-run              # valida; luego sin --dry-run para subir
python tools\check_ccse_manual.py --update-state  # marca el manual como revisado
```

Las `explicacion_facil` de las preguntas sustituidas hay que regenerarlas
(`tools/generate_explicaciones_faciles*.mjs`).
