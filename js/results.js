document.addEventListener('DOMContentLoaded', () => {
    const auth = firebase.auth();
    const db = firebase.firestore();
    const params = new URLSearchParams(window.location.search);
    const examId = params.get('examId');

    auth.onAuthStateChanged(async user => {
        if (!user) return;

        try {
            const profile = await loadUserProfile(user);
            const reviewLanguage = getReviewLanguage(user, profile);
            const review = examId
                ? await loadSavedExamReview(examId)
                : loadRecentExamReview();

            if (!review) {
                alert('No hay un examen reciente para mostrar.');
                window.location.href = 'dashboard.html';
                return;
            }

            renderReview(review, reviewLanguage);
        } catch (error) {
            console.error('No se pudo cargar la revisión del examen:', error);
            alert(`No se pudo cargar la revisión del examen: ${error.message}`);
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

    async function loadSavedExamReview(id) {
        const examDoc = await db.collection('exams').doc(id).get();
        if (!examDoc.exists) {
            throw new Error('El examen no existe o no tienes permiso para verlo.');
        }

        const exam = { id: examDoc.id, ...examDoc.data() };
        const answersSnapshot = await db.collection('exam_answers')
            .where('exam_id', '==', id)
            .get();
        const answers = [];
        answersSnapshot.forEach(doc => answers.push({ id: doc.id, ...doc.data() }));
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

    async function loadUserProfile(user) {
        try {
            const doc = await db.collection('users').doc(user.uid).get();
            return doc.exists ? doc.data() : null;
        } catch (error) {
            console.warn('No se pudo cargar el perfil del usuario para la revisión:', error);
            return null;
        }
    }

    function getReviewLanguage(user, profile) {
        const configuredLanguage = String(
            profile?.review_language || profile?.preferred_review_language || profile?.language || ''
        ).toLowerCase();
        if (configuredLanguage.startsWith('fr')) return 'fr';
        return isSamiraUser(user, profile) ? 'fr' : 'es';
    }

    function isSamiraUser(user, profile) {
        const identity = normalizeForMatch([
            user?.displayName,
            user?.email,
            profile?.name,
            profile?.displayName,
            profile?.email
        ].filter(Boolean).join(' '));
        return identity.includes('samira') && (identity.includes('raysse') || identity.includes('samira'));
    }

    function renderReview(review, language) {
        const { questions, userAnswers, summary, passingScore, totalQuestions } = review;
        const answered = summary.correct + summary.incorrect;
        const labels = getLabels(language);

        document.documentElement.lang = language === 'fr' ? 'fr' : 'es';
        document.getElementById('res-respondadas').textContent = answered;
        document.getElementById('res-no-respondidas').textContent = summary.unanswered;
        document.getElementById('res-bien').textContent = summary.correct;
        document.getElementById('res-mal').textContent = summary.incorrect;

        const resultTitle = document.getElementById('result-title');
        const passed = summary.correct >= passingScore;
        resultTitle.textContent = passed
            ? `${labels.passed}: ${summary.correct} de ${totalQuestions} ${labels.correctCount}`
            : `${labels.failed}: ${summary.correct} de ${totalQuestions} ${labels.correctCount}`;
        resultTitle.className = passed ? 'result-title passed' : 'result-title failed';
        renderSaveDiagnostic();

        const body = document.getElementById('tabla-preguntas-cuerpo');
        body.innerHTML = questions.map((question, index) => {
            const selectedKey = userAnswers[index] ?? null;
            const selectedOption = question.options.find(option => option.key === selectedKey);
            const correctOption = question.options.find(
                option => option.key === question.correct_answer
            );
            const correctAnswerText = formatOption(correctOption, language);
            const explanation = getSimpleExplanation(question, correctOption, language);
            let stateLabel = labels.unanswered;
            let stateClass = 'no-respondidas';
            let simpleExplanation = labels.unansweredExplanation(explanation);

            if (selectedKey === question.correct_answer) {
                stateLabel = labels.correct;
                stateClass = 'bien';
                simpleExplanation = labels.correctExplanation(explanation);
            } else if (selectedKey !== null) {
                stateLabel = labels.incorrect;
                stateClass = 'mal';
                simpleExplanation = labels.incorrectExplanation(explanation);
            }

            const state = `
                <span
                    class="result-with-help"
                    tabindex="0"
                    aria-describedby="help-${index}"
                    title="${escapeHtml(simpleExplanation)}"
                >
                    <span class="badge ${stateClass}">${stateLabel}</span>
                    <span id="help-${index}" class="simple-tooltip" role="tooltip">
                        ${escapeHtml(simpleExplanation)}
                    </span>
                </span>
            `;

            return `
                <tr>
                    <td class="center-text">${index + 1}</td>
                    <td>
                        <strong>${escapeHtml(question.question_text)}</strong>
                        <div class="answer-note">${labels.correctAnswer}: ${escapeHtml(correctAnswerText)}</div>
                    </td>
                    <td>${escapeHtml(selectedOption ? formatOption(selectedOption, language) : labels.noAnswerSymbol)}</td>
                    <td>${state}</td>
                </tr>
            `;
        }).join('');
    }

    function getLabels(language) {
        if (language === 'fr') {
            return {
                passed: 'APTE',
                failed: 'NON APTE',
                correctCount: 'bonnes réponses',
                correct: 'Correcte',
                incorrect: 'Incorrecte',
                unanswered: 'Sans réponse',
                correctAnswer: 'Réponse correcte',
                noAnswerSymbol: '-',
                correctExplanation: explanation => `Très bien. ${explanation}`,
                incorrectExplanation: explanation => `Ta réponse n'est pas correcte. ${explanation}`,
                unansweredExplanation: explanation => `Tu n'as pas choisi de réponse. ${explanation}`
            };
        }

        return {
            passed: 'APTO',
            failed: 'NO APTO',
            correctCount: 'aciertos',
            correct: 'Correcta',
            incorrect: 'Incorrecta',
            unanswered: 'No respondida',
            correctAnswer: 'Correcta',
            noAnswerSymbol: '-',
            correctExplanation: explanation => `¡Muy bien! ${explanation}`,
            incorrectExplanation: explanation => `Tu respuesta no es correcta. ${explanation}`,
            unansweredExplanation: explanation => `No elegiste una respuesta. ${explanation}`
        };
    }

    function formatOption(option) {
        return option ? `${String(option.key).toUpperCase()}) ${option.text}` : 'No disponible';
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

    function getSimpleExplanation(question, correctOption, language) {
        if (language === 'fr') {
            return getFrenchExplanation(question, correctOption);
        }
        return getSpanishExplanation(question, correctOption);
    }

    function getFrenchExplanation(question, correctOption) {
        if (question.explanation_fr) return question.explanation_fr;

        const answer = cleanSentence(correctOption?.text || 'Non disponible');
        const prompt = cleanSentence(question.question_text)
            .replace(/^¿/, '')
            .replace(/\?$/, '')
            .replace(/…$/, '')
            .trim();

        if (question.question_type === 'true_false') {
            if (question.correct_answer === 'a') {
                return `L'affirmation est vraie. L'idée à retenir est: ${prompt}.`;
            }
            return `L'affirmation est fausse. Il ne faut donc pas considérer comme correcte l'idée suivante: ${prompt}.`;
        }

        const howNamed = prompt.match(/^Cómo se (llama|llaman) (.+)$/i);
        if (howNamed) {
            return `La bonne réponse est ${lowercaseFirst(answer)}: c'est le nom à retenir pour ${howNamed[2].toLowerCase()}.`;
        }

        const who = prompt.match(/^Quién(?:es)? (.+)$/i);
        if (who) {
            return `${answer} est la réponse correcte pour cette question sur qui ${lowercaseFirst(who[1])}.`;
        }

        const where = prompt.match(/^Dónde (está|están|vive|viven|se encuentra|se encuentran) (.+)$/i);
        if (where) {
            return `La localisation correcte est ${lowercaseFirst(answer)}. C'est ce qu'il faut retenir pour ${where[2].toLowerCase()}.`;
        }

        const whatIs = prompt.match(/^Cuál es (.+)$/i);
        if (whatIs) {
            return `La bonne réponse est ${lowercaseFirst(answer)} pour identifier ${whatIs[1].toLowerCase()}.`;
        }

        const howManyExist = prompt.match(/^Cuánt(?:os|as) (.+?) hay (.+)$/i);
        if (howManyExist) {
            return `La quantité correcte est ${lowercaseFirst(answer)}. C'est le nombre à retenir.`;
        }

        const howManyHas = prompt.match(/^Cuánt(?:os|as) (.+?) tiene (.+)$/i);
        if (howManyHas) {
            return `La quantité correcte est ${lowercaseFirst(answer)}. C'est le nombre à retenir.`;
        }

        if (/^Cómo /i.test(prompt)) {
            return `La formulation correcte est ${lowercaseFirst(answer)}.`;
        }

        if (/…$/.test(question.question_text.trim())) {
            return `La phrase se complète avec ${lowercaseFirst(answer)}.`;
        }

        return `La réponse correcte est ${answer}. C'est l'idée principale à mémoriser pour cette question.`;
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
                return `La frase es verdadera. Puedes recordarla así: ${prompt}.`;
            }
            return `La frase es falsa. No debes tomar como correcto lo que dice: "${prompt}".`;
        }

        const howNamed = prompt.match(/^Cómo se (llama|llaman) (.+)$/i);
        if (howNamed) {
            const verb = howNamed[1].toLowerCase();
            return `${capitalize(howNamed[2])} se ${verb} ${lowercaseFirst(answer)}.`;
        }

        const who = prompt.match(/^Quién(?:es)? (.+)$/i);
        if (who) {
            return `${answer} ${lowercaseFirst(who[1])}.`;
        }

        const where = prompt.match(/^Dónde (está|están|vive|viven|se encuentra|se encuentran) (.+)$/i);
        if (where) {
            return `${capitalize(where[2])} ${where[1].toLowerCase()} ${lowercaseFirst(answer)}.`;
        }

        const whatIs = prompt.match(/^Cuál es (.+)$/i);
        if (whatIs) {
            return `${capitalize(whatIs[1])} es ${lowercaseFirst(answer)}.`;
        }

        const howManyExist = prompt.match(/^Cuánt(?:os|as) (.+?) hay (.+)$/i);
        if (howManyExist) {
            return `${capitalize(howManyExist[2])} hay ${lowercaseFirst(answer)} ${howManyExist[1].toLowerCase()}.`;
        }

        const howManyHas = prompt.match(/^Cuánt(?:os|as) (.+?) tiene (.+)$/i);
        if (howManyHas) {
            return `${capitalize(howManyHas[2])} tiene ${lowercaseFirst(answer)} ${howManyHas[1].toLowerCase()}.`;
        }

        const whichOne = prompt.match(
            /^Cuál de (?:estos|estas|los siguientes|las siguientes) .+? (se .+|es .+|tiene .+|está .+|permite .+)$/i
        );
        if (whichOne) {
            return `${answer} ${lowercaseFirst(whichOne[1])}.`;
        }

        if (/^Cómo /i.test(prompt)) {
            return `La forma correcta es ${lowercaseFirst(answer)}.`;
        }

        if (/…$/.test(question.question_text.trim())) {
            return `${capitalize(prompt)} ${lowercaseFirst(answer)}.`;
        }

        return `La respuesta correcta es ${answer}. Esta es la idea que debes recordar para esta pregunta.`;
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

    function cleanSentence(value) {
        return String(value).trim().replace(/[.\s]+$/, '');
    }

    function capitalize(value) {
        return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
    }

    function lowercaseFirst(value) {
        if (!value) return value;
        if (/^[A-ZÁÉÍÓÚÑ]{2,}\b/.test(value)) return value;
        return value.charAt(0).toLowerCase() + value.slice(1);
    }

    function normalizeForMatch(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
