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

## Modelo de datos

### `questions/{questionId}`

Cada documento se importa desde `preguntas.json` y contiene:

- `id` y `code`: código oficial único.
- `question_text`: enunciado.
- `options`: lista de objetos `{ key, text }`.
- `correct_answer`: clave de la opción correcta.
- `question_type`, `task_number`, `topic`, `active` y `source`.

### `exams/{examId}`

Resumen de cada examen: usuario, fecha, preguntas incluidas, puntuaciones,
distribución por tareas y resultado apto/no apto.

### `exam_answers/{examId_questionId}`

Una fila por pregunta presentada, incluida si quedó sin responder.

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
