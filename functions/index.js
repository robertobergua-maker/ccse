const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();

const OPENAI_API_KEY = defineSecret('OPENAI_API_KEY');
const ALLOWED_ORIGINS = new Set([
    'https://ccse-96981979-90250.web.app',
    'https://ccse-96981979-90250.firebaseapp.com',
    'http://localhost:5000',
    'http://127.0.0.1:5000'
]);

exports.explainExamMistake = onRequest(
    {
        region: 'us-central1',
        secrets: [OPENAI_API_KEY],
        timeoutSeconds: 30,
        memory: '256MiB'
    },
    async (request, response) => {
        setCorsHeaders(request, response);

        if (request.method === 'OPTIONS') {
            response.status(204).send('');
            return;
        }

        if (request.method !== 'POST') {
            response.status(405).json({ error: 'Método no permitido.' });
            return;
        }

        try {
            await verifyFirebaseAuth(request);
            const payload = normalizePayload(request.body || {});
            const explanation = await explainWithOpenAI(payload);
            response.json({ explanation });
        } catch (error) {
            console.error('No se pudo generar la explicación:', error);
            response.status(error.status || 500).json({
                error: error.publicMessage || 'No se pudo generar la explicación.'
            });
        }
    }
);

function setCorsHeaders(request, response) {
    const origin = request.get('origin');
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        response.set('Access-Control-Allow-Origin', origin);
    }
    response.set('Vary', 'Origin');
    response.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

async function verifyFirebaseAuth(request) {
    const header = request.get('authorization') || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
        const error = new Error('Falta el token de Firebase.');
        error.status = 401;
        error.publicMessage = 'Inicia sesión para generar explicaciones.';
        throw error;
    }
    await admin.auth().verifyIdToken(match[1]);
}

function normalizePayload(body) {
    const question = limitText(body.question, 500);
    const selectedAnswer = limitText(body.selectedAnswer || 'Sin responder', 160);
    const correctAnswer = limitText(body.correctAnswer, 160);
    const options = Array.isArray(body.options)
        ? body.options.slice(0, 4).map(option => ({
            key: limitText(option.key, 4),
            text: limitText(option.text, 160)
        }))
        : [];

    if (!question || !correctAnswer || options.length === 0) {
        const error = new Error('Faltan datos de la pregunta.');
        error.status = 400;
        error.publicMessage = 'Faltan datos para explicar esta pregunta.';
        throw error;
    }

    return {
        question,
        selectedAnswer,
        correctAnswer,
        options,
        wasUnanswered: body.wasUnanswered === true
    };
}

async function explainWithOpenAI(payload) {
    const apiKey = OPENAI_API_KEY.value() || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        const error = new Error('OPENAI_API_KEY no configurada.');
        error.status = 503;
        error.publicMessage = 'La explicación automática no está configurada todavía.';
        throw error;
    }

    const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: process.env.OPENAI_MODEL || 'gpt-5',
            max_output_tokens: 160,
            input: [
                {
                    role: 'system',
                    content: [
                        {
                            type: 'input_text',
                            text: [
                                'Eres profesor de preparación CCSE para personas extranjeras.',
                                'Explica en español muy claro y sencillo, nivel A2-B1.',
                                'No inventes datos fuera de la pregunta y las opciones.',
                                'Da una explicación de 2 o 3 frases cortas.',
                                'Explica por qué la respuesta correcta encaja y, si hubo fallo, por qué la elegida no encaja.'
                            ].join(' ')
                        }
                    ]
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: buildPrompt(payload)
                        }
                    ]
                }
            ]
        })
    });

    if (!openaiResponse.ok) {
        const detail = await openaiResponse.text();
        const error = new Error(`OpenAI respondió ${openaiResponse.status}: ${detail}`);
        error.status = 502;
        error.publicMessage = 'OpenAI no pudo generar la explicación ahora.';
        throw error;
    }

    const data = await openaiResponse.json();
    const text = extractOutputText(data);
    if (!text) {
        const error = new Error('Respuesta de OpenAI sin texto.');
        error.status = 502;
        error.publicMessage = 'OpenAI no devolvió una explicación legible.';
        throw error;
    }
    return limitText(text.replace(/\s+/g, ' ').trim(), 700);
}

function buildPrompt(payload) {
    const options = payload.options
        .map(option => `${String(option.key).toUpperCase()}) ${option.text}`)
        .join('\n');
    return [
        `Pregunta: ${payload.question}`,
        `Opciones:\n${options}`,
        `Respuesta del alumno: ${payload.wasUnanswered ? 'No respondió' : payload.selectedAnswer}`,
        `Respuesta correcta: ${payload.correctAnswer}`,
        'Escribe una explicación amable para entender el fallo.'
    ].join('\n\n');
}

function extractOutputText(data) {
    if (typeof data.output_text === 'string') return data.output_text;
    if (!Array.isArray(data.output)) return '';

    return data.output
        .flatMap(item => Array.isArray(item.content) ? item.content : [])
        .map(content => content.text || '')
        .filter(Boolean)
        .join(' ');
}

function limitText(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength);
}
