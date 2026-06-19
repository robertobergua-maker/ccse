document.addEventListener('DOMContentLoaded', () => {
    const auth = firebase.auth();
    const db = firebase.firestore();

    const ui = {
        startExamBtn: document.getElementById('start-exam-btn'),
        dbStatus: document.getElementById('db-status'),
        answered: document.getElementById('stat-respondidas'),
        unanswered: document.getElementById('stat-no-respondidas'),
        correct: document.getElementById('stat-acertadas'),
        wrong: document.getElementById('stat-falladas')
    };

    if (ui.startExamBtn) {
        ui.startExamBtn.addEventListener('click', () => {
            window.location.href = 'examen.html';
        });
    }

    auth.onAuthStateChanged(async user => {
        if (!user) return;

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
    });

    function setStatus(text, state) {
        if (!ui.dbStatus) return;
        ui.dbStatus.textContent = text;
        ui.dbStatus.className = `status-badge status-${state}`;
    }
});
