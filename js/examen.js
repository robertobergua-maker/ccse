document.addEventListener('DOMContentLoaded', () => {
    const OFFICIAL_TASK_RULES = {
        1: { amount: 10, type: 'multiple_choice', options: 3 },
        2: { amount: 3, type: 'true_false', options: 2 },
        3: { amount: 2, type: 'multiple_choice', options: 3 },
        4: { amount: 3, type: 'multiple_choice', options: 3 },
        5: { amount: 7, type: 'multiple_choice', options: 3 }
    };
    const OFFICIAL_DISTRIBUTION = Object.fromEntries(
        Object.entries(OFFICIAL_TASK_RULES).map(([task, rule]) => [task, rule.amount])
    );
    const EXAM_DURATION_SECONDS = 45 * 60;
    const PASSING_SCORE = 15;

    const db = firebase.firestore();
    let currentUser = null;
    let isGuest = false;
    let examQuestions = [];
    let userAnswers = {};
    let selectionContext = null;
    let timerInterval = null;
    let isFinishing = false;

    const ui = {
        examContainer: document.getElementById('exam-container'),
        submitExamBtn: document.getElementById('submit-exam-btn'),
        timer: document.getElementById('timer'),
        guestBanner: document.getElementById('guest-banner')
    };

    document.addEventListener('authReady', ({ detail }) => {
        currentUser = detail.user;
        isGuest = detail.isGuest;

        if (isGuest) {
            if (ui.guestBanner) ui.guestBanner.hidden = false;
            startGuestExam();
        } else {
            startNewExam(currentUser);
        }
    });

    ui.submitExamBtn.addEventListener('click', () => {
        if (confirm('¿Quieres finalizar y corregir el examen?')) {
            finishExam();
        }
    });

    // ── Modo invitado ────────────────────────────────────────────────────────

    async function startGuestExam() {
        try {
            const allQuestions = await loadQuestionBank();
            validateQuestionBank(allQuestions);
            selectionContext = { strategy: 'uniform_random', stats_source: 'none' };
            // Sin stats personalizadas: sorteo uniforme
            examQuestions = buildOfficialExam(allQuestions, new Map());
            userAnswers = {};
            sessionStorage.removeItem('lastExamSaveError');
            sessionStorage.removeItem('lastExamStatsSaveError');
            renderExam(examQuestions);
            startTimer(EXAM_DURATION_SECONDS);
        } catch (error) {
            console.error('No se pudo iniciar el examen de invitado:', error);
            ui.examContainer.innerHTML =
                `<p class="error-message">${escapeHtml(error.message)}.</p>`;
            ui.submitExamBtn.disabled = true;
        }
    }

    // ── Usuario registrado ───────────────────────────────────────────────────

    async function startNewExam(user) {
        try {
            const userId = user?.uid;
            if (!userId) {
                throw new Error('No se pudo identificar al usuario para personalizar el examen');
            }
            await assertUserCanSaveExam(userId);

            const [allQuestions, selectionStats] = await Promise.all([
                loadQuestionBank(),
                loadQuestionSelectionStats(userId)
            ]);
            validateQuestionBank(allQuestions);
            selectionContext = {
                strategy: 'cervantes_weighted_v2',
                priority_order: ['most_failed', 'least_seen', 'oldest_answered'],
                stats_source: 'user_question_stats',
                stats_user_id: userId,
                stats_count: selectionStats.size
            };
            examQuestions = buildOfficialExam(allQuestions, selectionStats);
            userAnswers = {};
            sessionStorage.removeItem('lastExamSaveError');
            sessionStorage.removeItem('lastExamStatsSaveError');
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

        Object.entries(OFFICIAL_TASK_RULES).forEach(([task, rule]) => {
            const available = questions.filter(question => question.task_number === Number(task)).length;
            const invalid = questions.filter(question =>
                question.task_number === Number(task)
                && (
                    question.question_type !== rule.type
                    || !Array.isArray(question.options)
                    || question.options.length !== rule.options
                )
            );
            if (invalid.length > 0) {
                throw new Error(`La tarea ${task} contiene preguntas que no respetan el formato oficial`);
            }
            if (available < rule.amount) {
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
            const snapshot = await db.collection('user_question_stats')
                .where('user_id', '==', userId)
                .get();

            snapshot.forEach(doc => {
                const data = doc.data();
                const questionId = data.question_id;
                if (!questionId) return;

                let lastAnsweredMs = 0;
                if (data.last_answered_at) {
                    if (typeof data.last_answered_at.toMillis === 'function') {
                        lastAnsweredMs = data.last_answered_at.toMillis();
                    } else if (data.last_answered_at.seconds) {
                        lastAnsweredMs = data.last_answered_at.seconds * 1000;
                    }
                }

                let lastFailedMs = 0;
                if (data.last_failed_at) {
                    if (typeof data.last_failed_at.toMillis === 'function') {
                        lastFailedMs = data.last_failed_at.toMillis();
                    } else if (data.last_failed_at.seconds) {
                        lastFailedMs = data.last_failed_at.seconds * 1000;
                    }
                } else if (data.last_correct === false && lastAnsweredMs > 0) {
                    lastFailedMs = lastAnsweredMs;
                }

                stats.set(questionId, {
                    appearances: data.total_attempts || 0,
                    wrong: data.total_incorrect || 0,
                    lastAnsweredMs: lastAnsweredMs,
                    lastFailedMs: lastFailedMs
                });
            });
        } catch (error) {
            console.warn('No se pudo cargar la ponderación de preguntas. Se usará sorteo uniforme.', error);
        }

        return stats;
    }

    function buildOfficialExam(questions, selectionStats) {
        return Object.entries(OFFICIAL_TASK_RULES).flatMap(([task, rule]) => {
            const taskQuestions = questions.filter(
                question => question.task_number === Number(task)
            );
            return weightedSample(taskQuestions, rule.amount, selectionStats);
        });
    }

    function weightedSample(questions, amount, selectionStats) {
        const now = Date.now();
        const maxAppearances = Math.max(
            0,
            ...questions.map(question => getQuestionStats(selectionStats, question.id).appearances)
        );

        return questions
            .map(question => {
                const stats = getQuestionStats(selectionStats, question.id);

                // Prioridad 1: Las más falladas por el usuario
                const wrongScore = stats.wrong * 100;

                // Prioridad 2: Las que menos han salido en sus exámenes
                const unseenScore = (maxAppearances - stats.appearances) * 10;

                // Prioridad 3: Las que hace más tiempo que no salen (o nunca han salido)
                let daysSinceLast = 365;
                if (stats.lastAnsweredMs > 0) {
                    daysSinceLast = Math.max(0, (now - stats.lastAnsweredMs) / (1000 * 60 * 60 * 24));
                }
                const timeScore = Math.min(daysSinceLast, 365) * 0.05;

                const weight = 1 + wrongScore + unseenScore + timeScore;

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
        return selectionStats.get(questionId) || { appearances: 0, wrong: 0, lastAnsweredMs: 0, lastFailedMs: 0 };
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

        const result = calculateResult();

        // Invitado: solo guardar en sessionStorage y mostrar resultados
        if (isGuest) {
            sessionStorage.setItem('examResults', JSON.stringify({
                questions: examQuestions,
                userAnswers,
                summary: result,
                passingScore: PASSING_SCORE
            }));
            window.location.href = 'results.html';
            return;
        }

        // Usuario registrado: guardar en Firestore
        ui.submitExamBtn.textContent = 'Guardando resultados…';

        let saveCheckpoint = 'inicio';
        let examId = '';

        try {
            saveCheckpoint = 'refrescar token';
            await currentUser.getIdToken(true);
            saveCheckpoint = 'comprobar usuario';
            await assertUserCanSaveExam(currentUser.uid);

            const examRef = db.collection('exams').doc();
            examId = examRef.id;
            const answerBatch = db.batch();
            const statsBatch = db.batch();
            let hasStatsWrites = false;

            const examData = {
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
            };

            saveCheckpoint = 'crear examen';
            await examRef.set(examData);

            saveCheckpoint = 'preparar respuestas';
            examQuestions.forEach((question, index) => {
                const selectedKey = userAnswers[index] ?? null;
                const answered = selectedKey !== null;
                const correct = answered && selectedKey === question.correct_answer;
                const answerRef = db.collection('exam_answers')
                    .doc(`${examRef.id}_${question.id}`);

                answerBatch.set(answerRef, {
                    user_id: currentUser.uid,
                    exam_id: examRef.id,
                    question_id: question.id,
                    question_text: String(question.question_text || ''),
                    task_number: Number(question.task_number || 0),
                    question_type: String(question.question_type || ''),
                    explicacion_facil: String(question.explicacion_facil || ''),
                    options: Array.isArray(question.options)
                        ? question.options.map(option => ({
                            key: option.key,
                            text: String(option.text || '')
                        }))
                        : [],
                    selected_answer: selectedKey,
                    correct_answer: question.correct_answer,
                    answered,
                    correct,
                    answered_at: firebase.firestore.FieldValue.serverTimestamp()
                });

                if (answered) {
                    const statRef = db.collection('user_question_stats')
                        .doc(`${currentUser.uid}_${question.id}`);
                    const statUpdate = {
                        user_id: currentUser.uid,
                        question_id: question.id,
                        question_text: String(question.question_text || ''),
                        task_number: Number(question.task_number || 0),
                        total_attempts: firebase.firestore.FieldValue.increment(1),
                        total_correct: firebase.firestore.FieldValue.increment(correct ? 1 : 0),
                        total_incorrect: firebase.firestore.FieldValue.increment(correct ? 0 : 1),
                        last_correct: correct,
                        last_answer: selectedKey,
                        last_answered_at: firebase.firestore.FieldValue.serverTimestamp()
                    };
                    if (!correct) {
                        statUpdate.last_failed_at = firebase.firestore.FieldValue.serverTimestamp();
                    }
                    statsBatch.set(statRef, statUpdate, { merge: true });
                    hasStatsWrites = true;
                }
            });

            saveCheckpoint = 'guardar respuestas';
            await answerBatch.commit();

            if (hasStatsWrites) {
                try {
                    saveCheckpoint = 'guardar estadísticas';
                    await statsBatch.commit();
                } catch (statsError) {
                    const diagnostic = buildSaveDiagnostic(saveCheckpoint, statsError, examId);
                    sessionStorage.setItem('lastExamStatsSaveError', JSON.stringify(diagnostic));
                    console.warn('El examen se guardó, pero no se pudieron actualizar las estadísticas:', diagnostic, statsError);
                }
            }
        } catch (error) {
            const diagnostic = buildSaveDiagnostic(saveCheckpoint, error, examId);
            sessionStorage.setItem('lastExamSaveError', JSON.stringify(diagnostic));
            console.error('No se pudieron guardar los resultados:', diagnostic, error);
            alert(
                'El examen se ha corregido, pero no se pudo guardar en la nube.\n' +
                `Punto de fallo: ${diagnostic.checkpoint}.\n` +
                `Código: ${diagnostic.code}.\n` +
                `Mensaje: ${diagnostic.message}`
            );
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

    function buildSaveDiagnostic(checkpoint, error, examId) {
        return {
            checkpoint,
            code: error?.code || error?.name || 'sin_codigo',
            message: error?.message || String(error || 'Error desconocido'),
            exam_id: examId || '',
            user_id: currentUser?.uid || '',
            email: currentUser?.email || '',
            timestamp: new Date().toISOString()
        };
    }

    async function assertUserCanSaveExam(userId) {
        const profileDoc = await db.collection('users').doc(userId).get();
        if (profileDoc.exists && profileDoc.data()?.blocked === true) {
            const error = new Error('Este usuario está bloqueado por el administrador. Desbloquéalo desde el panel admin para poder guardar exámenes.');
            error.code = 'usuario-bloqueado';
            throw error;
        }
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

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
