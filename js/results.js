document.addEventListener('DOMContentLoaded', () => {
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

            const questionBank = await loadQuestionBank();
            enrichReviewQuestions(review, questionBank);
            renderReview(review);
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
            if (answer.exam_id === id) answers.push(answer);
        });

        const orderedAnswers = sortExamAnswers(exam, answers);
        const questions = orderedAnswers.map(answer => ({
            id: answer.question_id,
            question_text: answer.question_text,
            task_number: answer.task_number,
            options: answer.options || [],
            correct_answer: answer.correct_answer,
            question_type: inferQuestionType(answer),
            explicacion_facil: answer.explicacion_facil || ''
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

    async function loadQuestionBank() {
        const localQuestions = await loadLocalQuestionBank();

        try {
            const snapshot = await db.collection('questions').get();
            const questions = [];
            snapshot.forEach(doc => questions.push({ id: doc.id, ...doc.data() }));
            if (questions.length > 0) {
                const localById = new Map(localQuestions.map(question => [String(question.id), question]));
                return new Map(questions.map(question => {
                    const local = localById.get(String(question.id)) || {};
                    return [
                        String(question.id),
                        {
                            ...local,
                            ...question,
                            explicacion_facil: question.explicacion_facil || local.explicacion_facil || ''
                        }
                    ];
                }));
            }
        } catch (error) {
            console.warn('No se pudo cargar questions desde Firestore. Se usará preguntas.json.', error);
        }

        return new Map(localQuestions.map(question => [String(question.id), question]));
    }

    async function loadLocalQuestionBank() {
        const response = await fetch('preguntas.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`No se pudo cargar el banco (${response.status})`);
        const questions = await response.json();
        return questions;
    }

    function enrichReviewQuestions(review, questionBank) {
        review.questions = review.questions.map(question => {
            const bankQuestion = questionBank.get(String(question.id));
            if (!bankQuestion) return question;

            return {
                ...bankQuestion,
                ...question,
                options: question.options?.length ? question.options : bankQuestion.options,
                correct_answer: question.correct_answer || bankQuestion.correct_answer,
                explicacion_facil: question.explicacion_facil || bankQuestion.explicacion_facil || ''
            };
        });
    }

    function renderReview(review) {
        const { questions, userAnswers, summary, passingScore, totalQuestions } = review;
        const answered = summary.correct + summary.incorrect;
        const mistakes = questions
            .map((question, index) => ({ question, index, selectedKey: userAnswers[index] ?? null }))
            .filter(item => item.selectedKey !== item.question.correct_answer);

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

        const reviewTitle = document.getElementById('review-title');
        if (reviewTitle) {
            reviewTitle.textContent = mistakes.length === 0
                ? 'Sin fallos que revisar'
                : `Auditoría de fallos explicada (${mistakes.length})`;
        }

        const body = document.getElementById('mistakes-review');
        if (mistakes.length === 0) {
            body.innerHTML = `
                <section class="empty-review">
                    <h3>No hay respuestas incorrectas.</h3>
                    <p>Has respondido correctamente todas las preguntas del examen.</p>
                </section>
            `;
            return;
        }

        body.innerHTML = mistakes.map(item => renderMistakeCard(item)).join('');
    }

    function renderMistakeCard({ question, index, selectedKey }) {
        const selectedOption = question.options.find(option => option.key === selectedKey);
        const correctOption = question.options.find(option => option.key === question.correct_answer);
        const explanation = getEasyExplanation(question, correctOption);

        return `
            <section class="mistake-card">
                <div class="mistake-heading">
                    <span class="question-number">Pregunta ${index + 1}</span>
                    <strong>${escapeHtml(question.question_text)}</strong>
                </div>

                <div class="answer-comparison">
                    <div class="answer-box answer-wrong">
                        <span class="answer-label">Tu respuesta</span>
                        <p>${escapeHtml(selectedOption ? formatOption(selectedOption) : 'No respondiste esta pregunta.')}</p>
                    </div>
                    <div class="answer-box answer-right">
                        <span class="answer-label">Respuesta correcta</span>
                        <p>${escapeHtml(formatOption(correctOption))}</p>
                    </div>
                </div>

                <div class="why-box">
                    <span class="why-title">Explicación sencilla</span>
                    <p>${escapeHtml(explanation)}</p>
                </div>
            </section>
        `;
    }

    function getEasyExplanation(question, correctOption) {
        const stored = String(question.explicacion_facil || '').trim();
        if (stored) return stored;

        const answer = cleanSentence(correctOption?.text || 'No disponible');
        if (question.question_type === 'true_false') {
            return question.correct_answer === 'a'
                ? 'La frase de la pregunta es correcta. Lee la idea completa y recuerda que esa información forma parte del contenido oficial del examen.'
                : 'La frase de la pregunta no es correcta. En las preguntas de verdadero o falso, hay que fijarse en una palabra que cambia el sentido de toda la frase.';
        }
        return `La idea importante de esta pregunta es ${lowercaseFirst(answer)}. Repasa el enunciado y relaciónalo con esa idea para recordarlo mejor.`;
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

    function lowercaseFirst(value) {
        if (!value) return value;
        if (/^[A-ZÁÉÍÓÚÑ]{2,}\b/.test(value)) return value;
        return value.charAt(0).toLowerCase() + value.slice(1);
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
