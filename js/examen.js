document.addEventListener('DOMContentLoaded', () => {
    const OFFICIAL_DISTRIBUTION = { 1: 10, 2: 3, 3: 2, 4: 3, 5: 7 };
    const EXAM_DURATION_SECONDS = 45 * 60;
    const PASSING_SCORE = 15;
    const UNSEEN_PRIORITY = 0.18;
    const WRONG_PRIORITY = 0.16;

    const auth = firebase.auth();
    const db = firebase.firestore();
    let currentUser = null;
    let examQuestions = [];
    let userAnswers = {};
    let selectionContext = null;
    let timerInterval = null;
    let isFinishing = false;

    const ui = {
        examContainer: document.getElementById('exam-container'),
        submitExamBtn: document.getElementById('submit-exam-btn'),
        timer: document.getElementById('timer')
    };

    auth.onAuthStateChanged(user => {
        if (!user) {
            window.location.href = 'login.html';
            return;
        }
        currentUser = user;
        startNewExam(user);
    });

    ui.submitExamBtn.addEventListener('click', () => {
        if (confirm('¿Quieres finalizar y corregir el examen?')) {
            finishExam();
        }
    });

    async function startNewExam(user) {
        try {
            const userId = user?.uid;
            if (!userId) {
                throw new Error('No se pudo identificar al usuario para personalizar el examen');
            }

            const [allQuestions, selectionStats] = await Promise.all([
                loadQuestionBank(),
                loadQuestionSelectionStats(userId)
            ]);
            validateQuestionBank(allQuestions);
            selectionContext = {
                strategy: 'per_user_weighted_v1',
                stats_source: 'exam_answers',
                stats_user_id: userId,
                stats_count: selectionStats.size,
                unseen_priority: UNSEEN_PRIORITY,
                wrong_priority: WRONG_PRIORITY
            };
            examQuestions = buildOfficialExam(allQuestions, selectionStats);
            userAnswers = {};
            renderExam(examQuestions);
            startTimer(EXAM_DURATION_SECONDS);
        } catch (error) {
            console.error('No se pudo iniciar el examen:', error);
            ui.examContainer.innerHTML =
                `<p class="error-message">${escapeHtml(error.message)}.</p>`;
            ui.submitExamBtn.disabled = true;
        }
    }

    function validateQuestionBank(questions) {
        if (questions.length !== 300) {
            throw new Error(`El banco oficial debe contener 300 preguntas y contiene ${questions.length}`);
        }

        const ids = new Set();
        questions.forEach(question => {
            if (!question.id || ids.has(question.id)) {
                throw new Error('El banco contiene un ID vacío o duplicado');
            }
            ids.add(question.id);

            if (!question.question_text || !Array.isArray(question.options)) {
                throw new Error(`La pregunta ${question.id} no tiene el esquema requerido`);
            }
            if (!question.options.some(option => option.key === question.correct_answer)) {
                throw new Error(`La pregunta ${question.id} tiene una solución inválida`);
            }
        });

        Object.entries(OFFICIAL_DISTRIBUTION).forEach(([task, required]) => {
            const available = questions.filter(question => question.task_number === Number(task)).length;
            if (available < required) {
                throw new Error(`No hay suficientes preguntas para la tarea ${task}`);
            }
        });
    }

    async function loadQuestionBank() {
        try {
            const snapshot = await db.collection('questions').get();
            const questions = [];
            snapshot.forEach(doc => questions.push({ id: doc.id, ...doc.data() }));
            if (questions.length > 0) {
                return sortQuestions(questions.filter(question => question.active !== false));
            }
        } catch (error) {
            console.warn('No se pudo cargar questions desde Firestore. Se usará preguntas.json.', error);
        }

        const response = await fetch('preguntas.json', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`No se pudo cargar el banco (${response.status})`);
        }
        return sortQuestions((await response.json()).filter(question => question.active !== false));
    }

    function sortQuestions(questions) {
        return questions.sort((left, right) =>
            String(left.id).localeCompare(String(right.id), 'es', { numeric: true })
        );
    }

    async function loadQuestionSelectionStats(userId) {
        const stats = new Map();

        try {
            const snapshot = await db.collection('exam_answers')
                .where('user_id', '==', userId)
                .get();

            snapshot.forEach(doc => {
                const answer = doc.data();
                const questionId = answer.question_id;
                if (!questionId) return;

                const current = stats.get(questionId) || { appearances: 0, wrong: 0 };
                current.appearances += 1;
                if (answer.answered === true && answer.correct === false) {
                    current.wrong += 1;
                }
                stats.set(questionId, current);
            });
        } catch (error) {
            console.warn('No se pudo cargar la ponderación de preguntas. Se usará sorteo uniforme.', error);
        }

        return stats;
    }

    function buildOfficialExam(questions, selectionStats) {
        return Object.entries(OFFICIAL_DISTRIBUTION).flatMap(([task, amount]) => {
            const taskQuestions = questions.filter(
                question => question.task_number === Number(task)
            );
            return weightedSample(taskQuestions, amount, selectionStats);
        });
    }

    function weightedSample(questions, amount, selectionStats) {
        const maxAppearances = Math.max(
            0,
            ...questions.map(question => getQuestionStats(selectionStats, question.id).appearances)
        );

        return questions
            .map(question => {
                const stats = getQuestionStats(selectionStats, question.id);
                const lessSeenBoost = Math.max(0, maxAppearances - stats.appearances) * UNSEEN_PRIORITY;
                const wrongBoost = stats.wrong * WRONG_PRIORITY;
                const weight = 1 + Math.min(lessSeenBoost, 1.8) + Math.min(wrongBoost, 1.2);

                return {
                    question,
                    rank: Math.random() ** (1 / weight)
                };
            })
            .sort((left, right) => right.rank - left.rank)
            .slice(0, amount)
            .map(item => item.question);
    }

    function getQuestionStats(selectionStats, questionId) {
        return selectionStats.get(questionId) || { appearances: 0, wrong: 0 };
    }

    function renderExam(questions) {
        ui.examContainer.innerHTML = questions.map((question, index) => `
            <section class="question-block" id="question-${index}">
                <h2>Pregunta ${index + 1} <span class="question-code">${escapeHtml(question.id)}</span></h2>
                <p>${escapeHtml(question.question_text)}</p>
                <div class="options" data-question-index="${index}">
                    ${question.options.map(option => `
                        <label class="option">
                            <input type="radio" name="q${index}" value="${escapeHtml(option.key)}">
                            <span><strong>${escapeHtml(option.key.toUpperCase())})</strong> ${escapeHtml(option.text)}</span>
                        </label>
                    `).join('')}
                </div>
            </section>
        `).join('');

        ui.examContainer.querySelectorAll('.option input').forEach(input => {
            input.addEventListener('change', event => {
                const questionIndex = Number(event.target.name.slice(1));
                userAnswers[questionIndex] = event.target.value;
                document.querySelectorAll(`input[name="q${questionIndex}"]`).forEach(option => {
                    option.closest('.option').classList.toggle('selected', option.checked);
                });
            });
        });
    }

    async function finishExam() {
        if (isFinishing) return;
        isFinishing = true;
        clearInterval(timerInterval);
        ui.submitExamBtn.disabled = true;
        ui.submitExamBtn.textContent = 'Guardando resultados…';

        const result = calculateResult();

        try {
            const examRef = db.collection('exams').doc();
            const batch = db.batch();

            batch.set(examRef, {
                user_id: currentUser.uid,
                finished_at: firebase.firestore.FieldValue.serverTimestamp(),
                score_correct: result.correct,
                score_incorrect: result.incorrect,
                score_unanswered: result.unanswered,
                total_questions: examQuestions.length,
                passing_score: PASSING_SCORE,
                passed: result.correct >= PASSING_SCORE,
                exam_mode: 'simulacro_oficial',
                task_distribution: OFFICIAL_DISTRIBUTION,
                selection_strategy: selectionContext,
                question_ids: examQuestions.map(question => question.id)
            });

            examQuestions.forEach((question, index) => {
                const selectedKey = userAnswers[index] ?? null;
                const answered = selectedKey !== null;
                const correct = answered && selectedKey === question.correct_answer;
                const answerRef = db.collection('exam_answers')
                    .doc(`${examRef.id}_${question.id}`);

                batch.set(answerRef, {
                    user_id: currentUser.uid,
                    exam_id: examRef.id,
                    question_id: question.id,
                    question_text: question.question_text,
                    task_number: question.task_number,
                    selected_answer: selectedKey,
                    correct_answer: question.correct_answer,
                    answered,
                    correct,
                    answered_at: firebase.firestore.FieldValue.serverTimestamp()
                });

                if (answered) {
                    const statRef = db.collection('user_question_stats')
                        .doc(`${currentUser.uid}_${question.id}`);
                    batch.set(statRef, {
                        user_id: currentUser.uid,
                        question_id: question.id,
                        question_text: question.question_text,
                        task_number: question.task_number,
                        total_attempts: firebase.firestore.FieldValue.increment(1),
                        total_correct: firebase.firestore.FieldValue.increment(correct ? 1 : 0),
                        total_incorrect: firebase.firestore.FieldValue.increment(correct ? 0 : 1),
                        last_correct: correct,
                        last_answer: selectedKey,
                        last_answered_at: firebase.firestore.FieldValue.serverTimestamp()
                    }, { merge: true });
                }
            });

            await batch.commit();
        } catch (error) {
            console.error('No se pudieron guardar los resultados:', error);
            alert('El examen se ha corregido, pero no se pudo guardar en la nube. Revisa tu conexión.');
        }

        sessionStorage.setItem('examResults', JSON.stringify({
            questions: examQuestions,
            userAnswers,
            summary: result,
            passingScore: PASSING_SCORE
        }));
        window.location.href = 'results.html';
    }

    function calculateResult() {
        return examQuestions.reduce((totals, question, index) => {
            const answer = userAnswers[index];
            if (answer === undefined || answer === null) totals.unanswered += 1;
            else if (answer === question.correct_answer) totals.correct += 1;
            else totals.incorrect += 1;
            return totals;
        }, { correct: 0, incorrect: 0, unanswered: 0 });
    }

    function startTimer(duration) {
        let remaining = duration;
        updateTimer(remaining);
        timerInterval = setInterval(() => {
            remaining -= 1;
            updateTimer(Math.max(remaining, 0));
            if (remaining <= 0) {
                clearInterval(timerInterval);
                alert('Tiempo agotado. El examen se corregirá automáticamente.');
                finishExam();
            }
        }, 1000);
    }

    function updateTimer(secondsLeft) {
        const minutes = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
        const seconds = String(secondsLeft % 60).padStart(2, '0');
        ui.timer.textContent = `${minutes}:${seconds}`;
    }

    function shuffleArray(values) {
        for (let index = values.length - 1; index > 0; index -= 1) {
            const randomIndex = Math.floor(Math.random() * (index + 1));
            [values[index], values[randomIndex]] = [values[randomIndex], values[index]];
        }
        return values;
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
