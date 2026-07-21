document.addEventListener('DOMContentLoaded', () => {
    const OFFICIAL_TASK_RULES = {
        1: { type: 'multiple_choice', options: 3 },
        2: { type: 'true_false', options: 2 },
        3: { type: 'multiple_choice', options: 3 },
        4: { type: 'multiple_choice', options: 3 },
        5: { type: 'multiple_choice', options: 3 }
    };
    const ENABLE_OPENAI_EXPLANATIONS = false;

    const auth = firebase.auth();
    const db = firebase.firestore();
    const params = new URLSearchParams(window.location.search);
    const examId = params.get('examId');

    auth.onAuthStateChanged(async user => {
        if (!user) return;

        try {
            const review = examId
                ? await loadSavedExamReview(examId, user.uid)
                : loadRecentExamReview();

            if (!review) {
                alert('No hay un examen reciente para mostrar.');
                window.location.href = 'dashboard.html';
                return;
            }

            renderReview(review, user);
        } catch (error) {
            console.error('No se pudo cargar la auditoría del examen:', error);
            alert(`No se pudo cargar la auditoría del examen: ${error.message}`);
            window.location.href = 'dashboard.html';
        }
    });

    function loadRecentExamReview() {
        const rawResults = sessionStorage.getItem('examResults');
        if (!rawResults) return null;

        const { questions, userAnswers, summary, passingScore = 15 } = JSON.parse(rawResults);
        return {
            questions,
            userAnswers,
            summary,
            passingScore,
            totalQuestions: questions.length
        };
    }

    async function loadSavedExamReview(id, userId) {
        const examDoc = await db.collection('exams').doc(id).get();
        if (!examDoc.exists) {
            throw new Error('El examen no existe o no tienes permiso para verlo.');
        }

        const exam = { id: examDoc.id, ...examDoc.data() };
        if (exam.user_id && exam.user_id !== userId) {
            throw new Error('Este examen pertenece a otro usuario.');
        }
        const answersSnapshot = await db.collection('exam_answers')
            .where('user_id', '==', userId)
            .get();
        const answers = [];
        answersSnapshot.forEach(doc => {
            const answer = { id: doc.id, ...doc.data() };
            if (answer.exam_id === id) {
                answers.push(answer);
            }
        });
        const orderedAnswers = sortExamAnswers(exam, answers);
        const questions = orderedAnswers.map(answer => ({
            id: answer.question_id,
            question_text: answer.question_text,
            task_number: answer.task_number,
            options: answer.options || [],
            correct_answer: answer.correct_answer,
            question_type: inferQuestionType(answer)
        }));
        const userAnswers = {};
        orderedAnswers.forEach((answer, index) => {
            if (answer.selected_answer !== null && answer.selected_answer !== undefined) {
                userAnswers[index] = answer.selected_answer;
            }
        });

        return {
            questions,
            userAnswers,
            summary: {
                correct: exam.score_correct || 0,
                incorrect: exam.score_incorrect || 0,
                unanswered: exam.score_unanswered || 0
            },
            passingScore: exam.passing_score || 15,
            totalQuestions: exam.total_questions || questions.length || 25
        };
    }

    function renderReview(review, user) {
        const { questions, userAnswers, summary, passingScore, totalQuestions } = review;
        const answered = summary.correct + summary.incorrect;

        document.documentElement.lang = 'es';
        document.getElementById('res-respondadas').textContent = answered;
        document.getElementById('res-no-respondidas').textContent = summary.unanswered;
        document.getElementById('res-bien').textContent = summary.correct;
        document.getElementById('res-mal').textContent = summary.incorrect;

        const resultTitle = document.getElementById('result-title');
        const passed = summary.correct >= passingScore;
        resultTitle.textContent = passed
            ? `APTO: ${summary.correct} de ${totalQuestions} aciertos`
            : `NO APTO: ${summary.correct} de ${totalQuestions} aciertos`;
        resultTitle.className = passed ? 'result-title passed' : 'result-title failed';
        renderSaveDiagnostic();

        const body = document.getElementById('tabla-preguntas-cuerpo');
        body.innerHTML = questions.map((question, index) => renderQuestionRow(question, index, userAnswers[index] ?? null)).join('');
        enhanceMistakeExplanations(questions, userAnswers, user);
    }

    function renderQuestionRow(question, index, selectedKey) {
        const selectedOption = question.options.find(option => option.key === selectedKey);
        const correctOption = question.options.find(option => option.key === question.correct_answer);
        const result = buildAnswerResult(question, selectedKey, selectedOption, correctOption);
        const audit = auditQuestionCoherence(question, selectedKey, selectedOption, correctOption);

        const state = `
            <span
                class="result-with-help"
                tabindex="0"
                aria-describedby="help-${index}"
                title="${escapeHtml(result.explanation)}"
            >
                <span class="badge ${result.stateClass}">${result.stateLabel}</span>
                <span id="help-${index}" class="simple-tooltip" role="tooltip">
                    ${escapeHtml(result.explanation)}
                </span>
            </span>
        `;

        return `
            <tr>
                <td class="center-text">${index + 1}</td>
                <td>
                    <strong>${escapeHtml(question.question_text)}</strong>
                    <div class="answer-note">Correcta: ${escapeHtml(formatOption(correctOption))}</div>
                    <div id="explanation-${index}" class="audit-note">${escapeHtml(result.explanation)}</div>
                </td>
                <td>${escapeHtml(selectedOption ? formatOption(selectedOption) : '-')}</td>
                <td>${state}</td>
                <td>
                    <span class="badge ${audit.ok ? 'audit-ok' : 'audit-warning'}">${audit.ok ? 'Coherente' : 'Revisar'}</span>
                    <div class="audit-note ${audit.ok ? '' : 'audit-warning'}">${escapeHtml(audit.message)}</div>
                </td>
            </tr>
        `;
    }

    function buildAnswerResult(question, selectedKey, selectedOption, correctOption) {
        const baseExplanation = getSpanishExplanation(question, correctOption);

        if (selectedKey === question.correct_answer) {
            return {
                stateLabel: 'Correcta',
                stateClass: 'bien',
                explanation: `Muy bien. ${baseExplanation}`
            };
        }

        if (selectedKey === null) {
            return {
                stateLabel: 'No respondida',
                stateClass: 'no-respondidas',
                explanation: `No marcaste ninguna opción. Lee la pregunta despacio y busca el dato principal. ${baseExplanation}`
            };
        }

        const selectedText = selectedOption ? formatOption(selectedOption) : `opción ${String(selectedKey).toUpperCase()}`;
        const correctText = formatOption(correctOption);
        return {
            stateLabel: 'Incorrecta',
            stateClass: 'mal',
            explanation: `Marcaste ${selectedText}. Esa opción no encaja con el dato oficial de la pregunta. La respuesta correcta es ${correctText}. ${baseExplanation}`
        };
    }

    function auditQuestionCoherence(question, selectedKey, selectedOption, correctOption) {
        const issues = [];
        const rule = OFFICIAL_TASK_RULES[Number(question.task_number)];

        if (!cleanSentence(question.question_text)) {
            issues.push('falta el enunciado');
        }
        if (!Array.isArray(question.options) || question.options.length === 0) {
            issues.push('no hay opciones registradas');
        }
        if (!correctOption) {
            issues.push('la respuesta correcta guardada no coincide con ninguna opción');
        }
        if (selectedKey !== null && !selectedOption) {
            issues.push('la respuesta elegida no coincide con ninguna opción guardada');
        }
        if (rule && question.question_type !== rule.type) {
            issues.push(`la tarea ${question.task_number} debería ser de tipo ${rule.type}`);
        }
        if (rule && Array.isArray(question.options) && question.options.length !== rule.options) {
            issues.push(`la tarea ${question.task_number} debería tener ${rule.options} opciones`);
        }

        if (issues.length > 0) {
            return {
                ok: false,
                message: `Hay que revisar este registro: ${issues.join('; ')}.`
            };
        }

        if (selectedKey === question.correct_answer) {
            return {
                ok: true,
                message: 'La pregunta, la opción marcada y la solución guardada son coherentes.'
            };
        }

        return {
            ok: true,
            message: 'La pregunta y sus opciones son coherentes; el fallo se debe a que la opción marcada no era la correcta.'
        };
    }

    async function enhanceMistakeExplanations(questions, userAnswers, user) {
        if (!ENABLE_OPENAI_EXPLANATIONS) return;

        const token = await user.getIdToken();
        await Promise.allSettled(questions.map(async (question, index) => {
            const selectedKey = userAnswers[index] ?? null;
            if (selectedKey === question.correct_answer) return;

            const target = document.getElementById(`explanation-${index}`);
            if (!target) return;

            const selectedOption = question.options.find(option => option.key === selectedKey);
            const correctOption = question.options.find(option => option.key === question.correct_answer);
            const fallback = target.textContent;
            const cacheKey = buildExplanationCacheKey(question, selectedKey);
            const cached = sessionStorage.getItem(cacheKey);
            if (cached) {
                target.textContent = cached;
                return;
            }

            target.textContent = 'Generando explicación sencilla...';
            try {
                const explanation = await requestOpenAIExplanation(question, selectedOption, correctOption, selectedKey, token);
                sessionStorage.setItem(cacheKey, explanation);
                target.textContent = explanation;
            } catch (error) {
                console.warn('No se pudo mejorar la explicación con OpenAI:', error);
                target.textContent = fallback;
            }
        }));
    }

    async function requestOpenAIExplanation(question, selectedOption, correctOption, selectedKey, token) {
        const endpoint = getFunctionsEndpoint('explainExamMistake');
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                question: question.question_text,
                options: question.options,
                selectedAnswer: selectedOption ? formatOption(selectedOption) : '',
                correctAnswer: formatOption(correctOption),
                wasUnanswered: selectedKey === null
            })
        });

        if (!response.ok) {
            throw new Error(`La función respondió ${response.status}`);
        }

        const data = await response.json();
        if (!data.explanation) {
            throw new Error('La función no devolvió explicación.');
        }
        return data.explanation;
    }

    function getFunctionsEndpoint(functionName) {
        const projectId = firebase.app().options.projectId;
        return `https://us-central1-${projectId}.cloudfunctions.net/${functionName}`;
    }

    function buildExplanationCacheKey(question, selectedKey) {
        return [
            'ai-explanation',
            question.id || normalizeForCache(question.question_text),
            selectedKey || 'sin-respuesta',
            question.correct_answer || ''
        ].join(':');
    }

    function renderSaveDiagnostic() {
        const target = document.getElementById('save-diagnostic');
        if (!target) return;

        const rawDiagnostic = sessionStorage.getItem('lastExamSaveError');
        if (!rawDiagnostic) return;

        try {
            const diagnostic = JSON.parse(rawDiagnostic);
            target.style.display = 'block';
            target.innerHTML = `
                <strong>Diagnóstico de guardado en la nube</strong>
                <dl>
                    <dt>Punto</dt><dd>${escapeHtml(diagnostic.checkpoint || 'No disponible')}</dd>
                    <dt>Código</dt><dd>${escapeHtml(diagnostic.code || 'No disponible')}</dd>
                    <dt>Mensaje</dt><dd>${escapeHtml(diagnostic.message || 'No disponible')}</dd>
                    <dt>Examen</dt><dd>${escapeHtml(diagnostic.exam_id || 'No disponible')}</dd>
                    <dt>Usuario</dt><dd>${escapeHtml(diagnostic.email || diagnostic.user_id || 'No disponible')}</dd>
                    <dt>Hora</dt><dd>${escapeHtml(diagnostic.timestamp || 'No disponible')}</dd>
                </dl>
            `;
        } catch (error) {
            target.style.display = 'block';
            target.textContent = `No se pudo leer el diagnóstico de guardado: ${rawDiagnostic}`;
        }
    }

    function getSpanishExplanation(question, correctOption) {
        if (question.explanation_simple) {
            return question.explanation_simple;
        }

        const answer = cleanSentence(correctOption?.text || 'No disponible');
        const prompt = cleanSentence(question.question_text)
            .replace(/^¿/, '')
            .replace(/\?$/, '')
            .replace(/…$/, '')
            .trim();

        if (question.question_type === 'true_false') {
            if (question.correct_answer === 'a') {
                return `La frase es verdadera. Esto significa que la idea de la pregunta sí es correcta: ${prompt}.`;
            }
            return `La frase es falsa. Esto significa que la idea de la pregunta no es correcta: "${prompt}".`;
        }

        const howNamed = prompt.match(/^Cómo se (llama|llaman) (.+)$/i);
        if (howNamed) {
            const verb = howNamed[1].toLowerCase();
            return `La pregunta pide un nombre. ${capitalize(howNamed[2])} se ${verb} ${lowercaseFirst(answer)}.`;
        }

        const who = prompt.match(/^Quién(?:es)? (.+)$/i);
        if (who) {
            return `La pregunta pide una persona o institución. La respuesta correcta es ${answer}.`;
        }

        const where = prompt.match(/^Dónde (está|están|vive|viven|se encuentra|se encuentran) (.+)$/i);
        if (where) {
            return `La pregunta pide un lugar. La respuesta correcta es ${answer}.`;
        }

        const whatIs = prompt.match(/^Cuál es (.+)$/i);
        if (whatIs) {
            return `La pregunta pide identificar el dato correcto. La respuesta es ${answer}.`;
        }

        const howManyExist = prompt.match(/^Cuánt(?:os|as) (.+?) hay (.+)$/i);
        if (howManyExist) {
            return `La pregunta pide una cantidad. El número correcto es ${answer}.`;
        }

        const howManyHas = prompt.match(/^Cuánt(?:os|as) (.+?) tiene (.+)$/i);
        if (howManyHas) {
            return `La pregunta pide una cantidad. El número correcto es ${answer}.`;
        }

        const whichOne = prompt.match(
            /^Cuál de (?:estos|estas|los siguientes|las siguientes) .+? (se .+|es .+|tiene .+|está .+|permite .+)$/i
        );
        if (whichOne) {
            return `Entre las opciones, la única que encaja es ${answer}.`;
        }

        if (/^Cómo /i.test(prompt)) {
            return `La forma correcta es ${answer}.`;
        }

        if (/…$/.test(question.question_text.trim())) {
            return `La frase se completa con ${answer}.`;
        }

        return `La respuesta correcta es ${answer}. Ese es el dato importante que debes recordar.`;
    }

    function sortExamAnswers(exam, answers) {
        const order = new Map((exam.question_ids || []).map((id, index) => [String(id), index]));
        return [...answers].sort((left, right) => {
            const leftOrder = order.has(String(left.question_id)) ? order.get(String(left.question_id)) : Number.MAX_SAFE_INTEGER;
            const rightOrder = order.has(String(right.question_id)) ? order.get(String(right.question_id)) : Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder || String(left.question_id).localeCompare(String(right.question_id), 'es', { numeric: true });
        });
    }

    function inferQuestionType(answer) {
        if (answer.question_type) return answer.question_type;
        return Array.isArray(answer.options) && answer.options.length === 2 ? 'true_false' : 'multiple_choice';
    }

    function formatOption(option) {
        return option ? `${String(option.key).toUpperCase()}) ${option.text}` : 'No disponible';
    }

    function cleanSentence(value) {
        return String(value || '').trim().replace(/[.\s]+$/, '');
    }

    function capitalize(value) {
        return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
    }

    function lowercaseFirst(value) {
        if (!value) return value;
        if (/^[A-ZÁÉÍÓÚÑ]{2,}\b/.test(value)) return value;
        return value.charAt(0).toLowerCase() + value.slice(1);
    }

    function normalizeForCache(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/-+/g, '-')
            .slice(0, 80);
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
