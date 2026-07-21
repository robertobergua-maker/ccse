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
        examHistoryBody: document.getElementById('exam-history-body'),
        adminPanelLink: document.getElementById('admin-panel-link')
    };

    if (ui.startExamBtn) {
        ui.startExamBtn.addEventListener('click', () => {
            window.location.href = 'examen.html';
        });
    }

    auth.onAuthStateChanged(async user => {
        if (!user) return;
        showAdminAccess(user);
        loadProgress(user);
        loadExamHistory(user);
    });

    function showAdminAccess(user) {
        if (!ui.adminPanelLink) return;
        const isAdmin = String(user.email || '').toLowerCase() === 'roberto.bergua@gmail.com';
        ui.adminPanelLink.hidden = !isAdmin;
        ui.adminPanelLink.classList.toggle('is-visible', isAdmin);
    }

    async function loadProgress(user) {
        if (!ui.answered) return;

        try {
            const [questions, statsSnapshot] = await Promise.all([
                loadQuestionBank(),
                db.collection('user_question_stats')
                    .where('user_id', '==', user.uid)
                    .get()
            ]);
            const activeQuestionIds = new Set(
                questions.filter(question => question.active !== false).map(question => question.id)
            );
            const validQuestionTexts = new Set(
                questions.filter(question => question.active !== false).map(question => normalizeForSearch(question.question_text))
            );
            const seenQuestionTexts = new Set();
            const obsoleteStats = [];
            const stats = [];

            statsSnapshot.forEach(doc => {
                const stat = doc.data();
                const statText = normalizeForSearch(stat.question_text);
                if (!statText || !validQuestionTexts.has(statText)) {
                    obsoleteStats.push(doc.ref);
                    return;
                }
                if ((stat.total_attempts || 0) > 0 && !seenQuestionTexts.has(statText)) {
                    seenQuestionTexts.add(statText);
                    stats.push(stat);
                }
            });
            await cleanupObsoleteStats(obsoleteStats);

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

    async function cleanupObsoleteStats(refs) {
        if (refs.length === 0) return;
        try {
            const chunkSize = 450;
            for (let index = 0; index < refs.length; index += chunkSize) {
                const batch = db.batch();
                refs.slice(index, index + chunkSize).forEach(ref => batch.delete(ref));
                await batch.commit();
            }
        } catch (error) {
            console.warn('No se pudieron limpiar estadísticas obsoletas del usuario:', error);
        }
    }

    async function loadQuestionBank() {
        try {
            const snapshot = await db.collection('questions').get();
            const questions = [];
            snapshot.forEach(doc => questions.push({ id: doc.id, ...doc.data() }));
            if (questions.length > 0) {
                return questions.filter(question => question.active !== false);
            }
        } catch (error) {
            console.warn('No se pudo cargar questions desde Firestore. Se usará preguntas.json.', error);
        }

        const response = await fetch('preguntas.json', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`No se pudo cargar el banco (${response.status})`);
        }
        return (await response.json()).filter(question => question.active !== false);
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
                '<tr><td colspan="6" class="empty-state">Aún no hay exámenes guardados.</td></tr>';
            return;
        }

        setExamHistorySummary(`Mostrando ${exams.length} simulacro${exams.length === 1 ? '' : 's'} guardado${exams.length === 1 ? '' : 's'}.`);
        ui.examHistoryBody.innerHTML = exams.map(exam => {
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
                    <td><a class="btn btn-secondary btn-compact" href="results.html?examId=${encodeURIComponent(exam.id)}">Auditar</a></td>
                </tr>
            `;
        }).join('');
    }

    function renderExamHistoryError() {
        if (!ui.examHistoryBody) return;
        setExamHistorySummary('Revisa la conexión o los permisos de Firestore.');
        ui.examHistoryBody.innerHTML =
            '<tr><td colspan="6" class="empty-state">No se pudo cargar el registro de exámenes.</td></tr>';
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

    function normalizeForSearch(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
});
