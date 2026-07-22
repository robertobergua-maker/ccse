import fs from 'node:fs/promises';

const INPUT_PATH = process.argv[2] || 'preguntas.json';
const OUTPUT_PATH = process.argv[3] || INPUT_PATH;
const MODEL = process.env.OPENAI_MODEL || 'gpt-5';
const BATCH_SIZE = Number(process.env.EXPLANATION_BATCH_SIZE || 8);
const FORCE = process.argv.includes('--force') || process.env.EXPLANATION_FORCE === '1';

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
    console.error('ERROR: falta OPENAI_API_KEY en el entorno.');
    process.exit(1);
}

const questions = JSON.parse(await fs.readFile(INPUT_PATH, 'utf8'));
const pending = FORCE
    ? questions
    : questions.filter(question => !String(question.explicacion_facil || '').trim());

console.log(`Preguntas: ${questions.length}. A generar: ${pending.length}. Modo force: ${FORCE ? 'sí' : 'no'}.`);

for (let index = 0; index < pending.length; index += BATCH_SIZE) {
    const batch = pending.slice(index, index + BATCH_SIZE);
    const explanations = await requestExplanations(batch);
    const byId = new Map(explanations.map(item => [String(item.id), cleanExplanation(item.explicacion_facil)]));

    for (const question of batch) {
        const explanation = byId.get(String(question.id));
        if (!isValidExplanation(explanation)) {
            throw new Error(`Explicación inválida para ${question.id}: ${explanation || '(vacía)'}`);
        }
        question.explicacion_facil = explanation;
        console.log(`OK ${question.id}: ${explanation.slice(0, 80)}...`);
    }

    await fs.writeFile(OUTPUT_PATH, JSON.stringify(questions, null, 2) + '\n', 'utf8');
    console.log(`Progreso guardado: ${Math.min(index + BATCH_SIZE, pending.length)}/${pending.length}`);
}

validateAll(questions);
await fs.writeFile(OUTPUT_PATH, JSON.stringify(questions, null, 2) + '\n', 'utf8');
console.log(`Completado: ${OUTPUT_PATH}`);

async function requestExplanations(batch) {
    const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODEL,
            max_output_tokens: 2600,
            input: [
                {
                    role: 'system',
                    content: [
                        {
                            type: 'input_text',
                            text: [
                                'Eres profesor de la prueba CCSE para personas extranjeras adultas.',
                                'Escribe en español muy sencillo, nivel A2-B1.',
                                'La explicación debe enseñar la idea, no repetir la opción correcta.',
                                'Usa frases cortas, vocabulario común y ejemplos de vida diaria cuando ayuden.',
                                'Explica por qué la respuesta correcta tiene sentido y por qué las otras opciones pueden confundir.',
                                'Si hay una institución, di qué hace con palabras sencillas.',
                                'Si hay una fecha, norma o documento, explica para qué sirve o por qué importa.',
                                'Si hay geografía, ayuda a situar el lugar sin meter datos innecesarios.',
                                'No uses lenguaje jurídico difícil.',
                                'No inventes datos fuera de la pregunta, sus opciones y el contenido oficial que evalúa.',
                                'No empieces con frases genéricas como "Esta pregunta comprueba un dato concreto".',
                                'Longitud: 55 a 110 palabras.',
                                'Devuelve SOLO JSON válido con esta forma: [{"id":"...","explicacion_facil":"..."}].'
                            ].join(' ')
                        }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: JSON.stringify(batch.map(toPromptQuestion), null, 2)
                        }
                    ]
                }
            ]
        })
    });

    if (!response.ok) {
        throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    const text = extractOutputText(data);
    try {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) throw new Error('la respuesta no es una lista');
        return parsed;
    } catch (error) {
        throw new Error(`No se pudo parsear JSON de OpenAI: ${error.message}\n${text}`);
    }
}

function toPromptQuestion(question) {
    const correctOption = question.options.find(option => option.key === question.correct_answer);
    return {
        id: question.id,
        tarea: question.task_number,
        tema: question.topic,
        pregunta: question.question_text,
        opciones: question.options.map(option => `${option.key.toUpperCase()}) ${option.text}`),
        respuesta_correcta: correctOption ? `${correctOption.key.toUpperCase()}) ${correctOption.text}` : question.correct_answer
    };
}

function extractOutputText(data) {
    if (typeof data.output_text === 'string') return data.output_text.trim();
    if (!Array.isArray(data.output)) return '';
    return data.output
        .flatMap(item => Array.isArray(item.content) ? item.content : [])
        .map(content => content.text || '')
        .filter(Boolean)
        .join('\n')
        .trim();
}

function cleanExplanation(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .replace(/^["']|["']$/g, '')
        .trim();
}

function isValidExplanation(value) {
    if (!value) return false;
    const words = value.split(/\s+/).filter(Boolean);
    return words.length >= 40 && words.length <= 130;
}

function validateAll(values) {
    const missing = values.filter(question => !isValidExplanation(question.explicacion_facil));
    if (missing.length > 0) {
        throw new Error(`Quedan explicaciones inválidas: ${missing.map(question => question.id).join(', ')}`);
    }
}
