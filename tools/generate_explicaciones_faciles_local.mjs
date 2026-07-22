import fs from 'node:fs/promises';

const INPUT_PATH = process.argv[2] || 'preguntas.json';
const OUTPUT_PATH = process.argv[3] || INPUT_PATH;

const questions = JSON.parse(await fs.readFile(INPUT_PATH, 'utf8'));

for (const question of questions) {
    question.explicacion_facil = buildExplanation(question);
}

validateAll(questions);
await fs.writeFile(OUTPUT_PATH, JSON.stringify(questions, null, 2) + '\n', 'utf8');
console.log(`explicacion_facil generada para ${questions.length} preguntas en ${OUTPUT_PATH}`);

function buildExplanation(question) {
    const prompt = cleanQuestion(question.question_text);
    const answer = cleanAnswer(correctOption(question)?.text || '');
    const wrongOptions = question.options
        .filter(option => option.key !== question.correct_answer)
        .map(option => cleanAnswer(option.text))
        .filter(Boolean);
    const lower = normalize(`${prompt} ${answer}`);

    if (question.question_type === 'true_false') {
        return trueFalseExplanation(question, prompt);
    }

    const special = specialExplanation(lower, prompt, answer, wrongOptions);
    if (special) return special;

    if (/quien|quienes/.test(lower)) {
        return clampWords([
            `Esta pregunta busca identificar quién tiene una función concreta.`,
            `En el contenido CCSE, esa función corresponde a ${lowercaseFirst(answer)}.`,
            `No conviene elegir por parecido de nombres: las otras opciones pueden ser instituciones o personas importantes, pero no son las que realizan esa tarea.`,
            `Para recordarlo, une la acción de la pregunta con la institución o persona que la hace.`
        ].join(' '));
    }

    if (/cuantos|cuantas|cuanto|cuanta|numero|n[uú]mero|edad|año|anos|km|hora|gramos|litro/.test(lower)) {
        return clampWords([
            `Esta pregunta pide recordar una cantidad concreta.`,
            `El dato que debes asociar con el enunciado es ${lowercaseFirst(answer)}.`,
            `Las otras opciones son números posibles, pero no son el dato oficial que se estudia para esta pregunta.`,
            `Para recordarlo, repite la pregunta junto con la cantidad correcta como si fuera una pequeña frase.`
        ].join(' '));
    }

    if (/dni|pasaporte|tarjeta|certificado|informe|receta|farmacia|salud|seguridad social|tr[aá]mite|cita|registro|compran|comprar|venden|vender/.test(lower)) {
        return clampWords([
            `Esta pregunta trata de un trámite, documento o servicio de la vida diaria.`,
            `La opción correcta se relaciona con una situación práctica: ${lowercaseFirst(answer)}.`,
            `Las otras opciones pueden existir, pero sirven para otros momentos.`,
            `Para recordarlo, imagina la situación real: qué necesitas hacer y a qué lugar, documento o servicio debes acudir.`
        ].join(' '));
    }

    if (/ley|constituci[oó]n|estatuto|decreto|derecho|deber|permiso|obligatorio|prohibido|laboral/.test(lower)) {
        return clampWords([
            `Esta pregunta trata de una norma, un derecho o una obligación.`,
            `La respuesta correcta señala la regla que se aplica en España: ${lowercaseFirst(answer)}.`,
            `No hace falta aprender muchos detalles jurídicos para esta pregunta.`,
            `Lo importante es recordar en qué situación se usa esa regla y no confundirla con otras normas parecidas.`
        ].join(' '));
    }

    if (/donde|ciudad|provincia|comunidad|isla|(^| )rio( |$)|r[ií]o|monta|(^| )mar( |$)|oc[eé]ano|capital|costa|norte|sur|este|oeste/.test(lower)) {
        return clampWords([
            `Esta pregunta es de geografía o localización.`,
            `La idea importante es situar correctamente el lugar: ${answer}.`,
            `Las otras opciones pueden estar en España o ser conocidas, pero no responden al lugar que pide el enunciado.`,
            `Para memorizarlo, relaciona el nombre del lugar con el mapa o con la zona de España donde aparece.`
        ].join(' '));
    }

    if (/instituto|tribunal|congreso|senado|cortes|gobierno|ministerio|defensor|ayuntamiento|polic[ií]a|guardia|comisi[oó]n|parlamento|junta/.test(lower)) {
        return clampWords([
            `Esta pregunta habla de una institución.`,
            `Una institución es un organismo que tiene una tarea pública.`,
            `Aquí debes recordar que ${lowercaseFirst(answer)} es la opción relacionada con la función que aparece en el enunciado.`,
            `Las otras respuestas pueden sonar oficiales, pero corresponden a otro nivel o a otra función.`
        ].join(' '));
    }

    if (/fiesta|museo|premio|literatura|pintor|escritor|camino|patrimonio|deporte|cultura|historia|rey|presidente/.test(lower)) {
        return clampWords([
            `Esta pregunta pertenece a cultura, historia o vida social española.`,
            `El punto que se quiere recordar es ${lowercaseFirst(answer)}.`,
            `No se trata solo de memorizar una palabra, sino de relacionarla con su importancia en España.`,
            `Para estudiarlo, piensa en qué representa esa persona, lugar, fiesta o hecho dentro de la cultura española.`
        ].join(' '));
    }

    return clampWords([
        `Esta pregunta comprueba un dato concreto del manual CCSE.`,
        `La idea que debes recordar es ${lowercaseFirst(answer)}.`,
        `Las otras opciones pueden parecer posibles, pero no encajan con el enunciado exacto.`,
        `Para estudiarla mejor, convierte la pregunta y la idea correcta en una frase sencilla y repítela varias veces.`
    ].join(' '));
}

function specialExplanation(lower, prompt, answer, wrongOptions) {
    if (/elecciones municipales/.test(lower)) {
        return 'Las elecciones municipales son las elecciones del municipio, es decir, del lugar donde vive la gente. En ellas se eligen las personas que trabajan en el ayuntamiento y toman decisiones cercanas, como servicios, calles o actividades locales. No son elecciones para formar el Gobierno de España ni para elegir representantes nacionales.';
    }
    if (/parlamento espa/.test(lower) || /cortes generales/.test(lower)) {
        return 'En España, el Parlamento nacional se llama Cortes Generales. Está formado por el Congreso de los Diputados y el Senado. Su función principal es representar a los ciudadanos y aprobar leyes. Por eso no hay que confundir una sola cámara, como el Congreso, con el nombre completo del Parlamento.';
    }
    if (/presidente del gobierno/.test(lower) && /elige|elegir|vota/.test(lower)) {
        return 'Después de las elecciones generales, los ciudadanos eligen diputados. Luego, esos diputados votan en el Congreso para decidir quién será presidente del Gobierno. Por eso la elección no la hacen los ciudadanos directamente, sino el Congreso de los Diputados.';
    }
    if (/dni/.test(lower)) {
        return 'El DNI es el documento que identifica oficialmente a los ciudadanos españoles. Sirve para demostrar quién eres cuando haces trámites, viajas dentro de ciertos lugares o necesitas identificarte. No es un permiso ni una tarjeta sanitaria: su función principal es confirmar la identidad.';
    }
    if (/ayuntamiento/.test(lower)) {
        return 'El ayuntamiento es el gobierno de un municipio. Se ocupa de asuntos cercanos a los vecinos, como calles, limpieza, parques, instalaciones deportivas o actividades culturales. No dirige todo el país ni una comunidad autónoma: trabaja en el nivel local.';
    }
    if (/comunidades aut[oó]nomas/.test(lower)) {
        return 'España se organiza en comunidades autónomas. Cada una tiene instituciones propias para gestionar servicios importantes, como sanidad o educación, dentro de su territorio. Este dato ayuda a entender que España no funciona solo desde el Gobierno central; también hay gobiernos autonómicos.';
    }
    if (/soberan[ií]a nacional/.test(lower)) {
        return 'La soberanía nacional significa que el poder político nace del pueblo. En una democracia, los ciudadanos participan votando y eligiendo representantes. Por eso la idea central no es que mande una sola institución, sino que la autoridad viene de los ciudadanos españoles.';
    }
    if (/constituci[oó]n/.test(lower)) {
        return 'La Constitución es la norma más importante de España. Organiza el Estado, reconoce derechos y explica cómo funcionan las instituciones principales. Es importante porque todas las demás leyes deben respetarla. Para recordarlo, piensa en ella como la base de las reglas del país.';
    }
    if (/tribunal constitucional/.test(lower)) {
        return 'El Tribunal Constitucional controla que las leyes respeten la Constitución. Su trabajo no es gobernar ni hacer leyes nuevas, sino interpretar la Constitución cuando hay dudas importantes. Para recordarlo, une “Constitucional” con “Constitución”: revisa si algo encaja con ella.';
    }
    if (/defensor del pueblo/.test(lower)) {
        return 'El Defensor del Pueblo protege a las personas cuando tienen problemas con una administración pública. Sirve para presentar quejas si una institución no actúa correctamente. No es un juez ni un político del Gobierno: su función es escuchar y defender derechos de los ciudadanos.';
    }
    if (/lengua|idioma|castellano|espa[nñ]ol|euskera|catal[aá]n|gallego/.test(lower)) {
        return clampWords([
            `Esta pregunta trata de las lenguas en España.`,
            `El dato que debes recordar es ${answer}.`,
            `El castellano o español es oficial en todo el país, y algunas comunidades tienen además otra lengua oficial.`,
            `Para memorizarlo, relaciona cada lengua con el territorio donde se usa oficialmente.`
        ].join(' '));
    }
    if (/bandera/.test(lower)) {
        return 'La bandera es uno de los símbolos oficiales de España. Sus colores y su uso ayudan a identificar al Estado en edificios públicos y actos oficiales. Para recordarla, piensa en la imagen más conocida: franjas rojas y amarilla, presente en instituciones públicas.';
    }
    if (/sanidad|educaci[oó]n/.test(lower)) {
        return 'En España algunos servicios importantes, como sanidad o educación, los gestionan las comunidades autónomas. Eso significa que no todo lo organiza directamente el Gobierno central. Para recordarlo, piensa que estos servicios se administran cerca del territorio donde vive la población.';
    }
    if (/seguridad social|vida laboral|cotizaci[oó]n/.test(lower)) {
        return 'Esta pregunta trata del trabajo y la Seguridad Social. La Seguridad Social guarda información sobre cotizaciones, prestaciones y derechos laborales. El dato correcto sirve para saber qué documento o institución se usa cuando una persona necesita consultar su situación laboral.';
    }
    if (/112|emergencia/.test(lower)) {
        return 'El 112 es el número para emergencias. Se usa cuando hay una situación urgente y se necesita ayuda rápida, por ejemplo policía, ambulancia o bomberos. Para recordarlo, piensa que es un número único y fácil para pedir ayuda en casos graves.';
    }
    return '';
}

function trueFalseExplanation(question, prompt) {
    if (question.correct_answer === 'a') {
        return clampWords([
            `Esta frase es verdadera según el contenido oficial del examen.`,
            `La clave es leerla completa y comprobar que no cambia ningún dato importante.`,
            `En las preguntas de verdadero o falso, una sola palabra puede modificar el sentido.`,
            `Aquí la idea general coincide con lo que hay que estudiar: ${lowercaseFirst(prompt)}.`
        ].join(' '));
    }

    return clampWords([
        `Esta frase es falsa según el contenido oficial del examen.`,
        `El fallo suele estar en una palabra que cambia el sentido, como una cantidad, una institución o una obligación.`,
        `No basta con que la frase suene parecida a algo correcto.`,
        `Hay que comprobar si toda la idea coincide con el dato oficial.`
    ].join(' '));
}

function correctOption(question) {
    return question.options.find(option => option.key === question.correct_answer);
}

function cleanQuestion(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function cleanAnswer(value) {
    return cleanSentence(String(value || '')
        .replace(/^\.\s*/, '')
        .replace(/\s+/g, ' ')
        .trim());
}

function cleanSentence(value) {
    return String(value || '').trim().replace(/[.\s]+$/, '');
}

function lowercaseFirst(value) {
    const cleaned = cleanSentence(value);
    if (!cleaned) return cleaned;
    if (/^[A-ZÁÉÍÓÚÑ]{2,}\b/.test(cleaned)) return cleaned;
    return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function normalize(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9ñ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function clampWords(value) {
    const words = value.split(/\s+/).filter(Boolean);
    if (words.length <= 90) return value;
    return words.slice(0, 90).join(' ').replace(/[,:;]$/, '') + '.';
}

function validateAll(values) {
    const invalid = values.filter(question => {
        const words = String(question.explicacion_facil || '').split(/\s+/).filter(Boolean);
        return words.length < 35 || words.length > 105;
    });
    if (invalid.length > 0) {
        throw new Error(`Explicaciones fuera de rango: ${invalid.map(question => `${question.id}(${question.explicacion_facil.split(/\s+/).length})`).join(', ')}`);
    }
}
