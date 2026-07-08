document.addEventListener('DOMContentLoaded', () => {
    const auth = firebase.auth();
    const db = firebase.firestore();

    const ui = {
        startExamBtn: document.getElementById('start-exam-btn'),
        dbStatus: document.getElementById('db-status'),
        answered: document.getElementById('stat-respondidas'),
        unanswered: document.getElementById('stat-no-respondidas'),
        correct: document.getElementById('stat-acertadas'),
        wrong: document.getElementById('stat-falladas'),
        examHistorySummary: document.getElementById('exam-history-summary'),
        examHistoryBody: document.getElementById('exam-history-body')
    };

    if (ui.startExamBtn) {
        ui.startExamBtn.addEventListener('click', () => {
            window.location.href = 'examen.html';
        });
    }

    auth.onAuthStateChanged(async user => {
        if (!user) return;
        loadProgress(user);
        loadExamHistory(user);
    });

    async function loadProgress(user) {
        if (!ui.answered) return;

        try {
            const [questionsResponse, statsSnapshot] = await Promise.all([
                fetch('preguntas.json', { cache: 'no-store' }),
                db.collection('user_question_stats')
                    .where('user_id', '==', user.uid)
                    .get()
            ]);

            if (!questionsResponse.ok) {
                throw new Error(`No se pudo cargar el banco (${questionsResponse.status})`);
            }

            const questions = await questionsResponse.json();
            const activeQuestionIds = new Set(
                questions.filter(question => question.active !== false).map(question => question.id)
            );
            const stats = [];

            statsSnapshot.forEach(doc => {
                const stat = doc.data();
                if (activeQuestionIds.has(stat.question_id) && (stat.total_attempts || 0) > 0) {
                    stats.push(stat);
                }
            });

            const answered = stats.length;
            const correct = stats.filter(stat => stat.last_correct === true).length;
            const wrong = stats.filter(stat => stat.last_correct === false).length;

            ui.answered.textContent = answered;
            ui.unanswered.textContent = Math.max(activeQuestionIds.size - answered, 0);
            ui.correct.textContent = correct;
            ui.wrong.textContent = wrong;
            setStatus(`Banco verificado: ${activeQuestionIds.size}`, 'online');
        } catch (error) {
            console.error('No se pudieron cargar las métricas:', error);
            setStatus('Sin conexión', 'offline');
        }
    }

    async function loadExamHistory(user) {
        if (!ui.examHistoryBody) return;

        try {
            const snapshot = await db.collection('exams')
                .where('user_id', '==', user.uid)
                .get();
            renderExamHistory(snapshot);
        } catch (error) {
            console.error('No se pudo cargar el registro de exámenes:', error);
            renderExamHistoryError();
        }
    }

    function renderExamHistory(snapshot) {
        if (!ui.examHistoryBody) return;

        const exams = [];
        snapshot.forEach(doc => {
            exams.push({ id: doc.id, ...doc.data() });
        });

        exams.sort((a, b) => timestampToMillis(b.finished_at) - timestampToMillis(a.finished_at));

        if (exams.length === 0) {
            setExamHistorySummary('No hay simulacros guardados todavía.');
            ui.examHistoryBody.innerHTML =
                '<tr><td colspan="5" class="empty-state">Aún no hay exámenes guardados.</td></tr>';
            return;
        }

        setExamHistorySummary(`Mostrando ${Math.min(exams.length, 20)} de ${exams.length} simulacros guardados.`);
        ui.examHistoryBody.innerHTML = exams.slice(0, 20).map(exam => {
            const correct = exam.score_correct || 0;
            const total = exam.total_questions || 25;
            const passed = exam.passed === true;
            const badgeClass = passed ? 'result-correct' : 'result-wrong';
            const resultText = passed ? 'Apto' : 'No apto';

            return `
                <tr>
                    <td>${escapeHtml(formatDate(exam.finished_at))}</td>
                    <td><span class="result-badge ${badgeClass}">${resultText}</span></td>
                    <td><strong>${correct}/${total}</strong></td>
                    <td>${exam.score_incorrect || 0}</td>
                    <td>${exam.score_unanswered || 0}</td>
                </tr>
            `;
        }).join('');
    }

    function renderExamHistoryError() {
        if (!ui.examHistoryBody) return;
        setExamHistorySummary('Revisa la conexión o los permisos de Firestore.');
        ui.examHistoryBody.innerHTML =
            '<tr><td colspan="5" class="empty-state">No se pudo cargar el registro de exámenes.</td></tr>';
    }

    function setStatus(text, state) {
        if (!ui.dbStatus) return;
        ui.dbStatus.textContent = text;
        ui.dbStatus.className = `status-badge status-${state}`;
    }

    function setExamHistorySummary(text) {
        if (!ui.examHistorySummary) return;
        ui.examHistorySummary.textContent = text;
    }

    function timestampToMillis(timestamp) {
        if (!timestamp) return 0;
        if (typeof timestamp.toMillis === 'function') return timestamp.toMillis();
        if (timestamp.seconds) return timestamp.seconds * 1000;
        return 0;
    }

    function formatDate(timestamp) {
        const millis = timestampToMillis(timestamp);
        if (!millis) return 'Fecha pendiente';

        return new Intl.DateTimeFormat('es-ES', {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(new Date(millis));
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
