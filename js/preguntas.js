document.addEventListener('DOMContentLoaded', () => {
    const auth = firebase.auth();
    const db = firebase.firestore();
    const filter = new URLSearchParams(window.location.search).get('filtro') || 'todas';
    const validFilters = new Set(['todas', 'respondidas', 'no-respondidas', 'acertadas', 'falladas']);
    const activeFilter = validFilters.has(filter) ? filter : 'todas';

    const labels = {
        'todas': 'Detalle de todas las preguntas',
        'respondidas': 'Preguntas respondidas',
        'no-respondidas': 'Preguntas no respondidas',
        'acertadas': 'Preguntas acertadas',
        'falladas': 'Preguntas falladas'
    };

    const ui = {
        title: document.getElementById('detail-title'),
        summary: document.getElementById('detail-summary'),
        body: document.getElementById('questions-body'),
        sortButtons: [...document.querySelectorAll('.sort-button')]
    };
    let visibleRows = [];
    let sortState = { key: 'attempts', direction: 'desc' };

    ui.title.textContent = labels[activeFilter];
    document.querySelectorAll('.filter-nav a').forEach(link => {
        const linkFilter = new URL(link.href).searchParams.get('filtro');
        link.classList.toggle('active', linkFilter === activeFilter);
    });

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

            const questions = (await questionsResponse.json())
                .filter(question => question.active !== false);
            const statsByQuestion = new Map();
            statsSnapshot.forEach(doc => {
                const stat = doc.data();
                statsByQuestion.set(stat.question_id, stat);
            });

            visibleRows = questions.map(question => {
                const stat = statsByQuestion.get(question.id) || {};
                return {
                    question,
                    attempts: stat.total_attempts || 0,
                    correct: stat.total_correct || 0,
                    incorrect: stat.total_incorrect || 0,
                    lastCorrect: typeof stat.last_correct === 'boolean' ? stat.last_correct : null
                };
            }).filter(matchesFilter);

            sortAndRender();
            ui.summary.textContent =
                `${visibleRows.length} pregunta${visibleRows.length === 1 ? '' : 's'}. Puedes ordenar la tabla pulsando cualquier columna.`;
        } catch (error) {
            console.error('No se pudo cargar el detalle:', error);
            ui.summary.textContent = 'No se pudo cargar el detalle.';
            ui.body.innerHTML = '<tr><td colspan="7" class="empty-state">Error al cargar los datos.</td></tr>';
        }
    });

    ui.sortButtons.forEach(button => {
        button.addEventListener('click', () => {
            const key = button.dataset.sort;
            if (sortState.key === key) {
                sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
            } else {
                sortState = {
                    key,
                    direction: ['attempts', 'correct', 'incorrect', 'task'].includes(key)
                        ? 'desc'
                        : 'asc'
                };
            }
            sortAndRender();
        });
    });

    function matchesFilter(row) {
        if (activeFilter === 'respondidas') return row.attempts > 0;
        if (activeFilter === 'no-respondidas') return row.attempts === 0;
        if (activeFilter === 'acertadas') return row.lastCorrect === true;
        if (activeFilter === 'falladas') return row.lastCorrect === false;
        return true;
    }

    function renderRows(rows) {
        if (rows.length === 0) {
            ui.body.innerHTML = '<tr><td colspan="7" class="empty-state">No hay preguntas en esta categoría.</td></tr>';
            return;
        }

        ui.body.innerHTML = rows.map(row => {
            let result = '<span class="result-badge result-pending">Sin responder</span>';
            if (row.lastCorrect === true) {
                result = '<span class="result-badge result-correct">Acierto</span>';
            } else if (row.lastCorrect === false) {
                result = '<span class="result-badge result-wrong">Fallo</span>';
            }

            return `
                <tr>
                    <td><strong>${escapeHtml(row.question.id)}</strong></td>
                    <td>${escapeHtml(row.question.question_text)}</td>
                    <td>${row.question.task_number}</td>
                    <td>${row.attempts}</td>
                    <td>${row.correct}</td>
                    <td>${row.incorrect}</td>
                    <td>${result}</td>
                </tr>
            `;
        }).join('');
    }

    function sortAndRender() {
        const direction = sortState.direction === 'asc' ? 1 : -1;
        const sortedRows = [...visibleRows].sort((left, right) => {
            const comparison = compareValues(
                getSortValue(left, sortState.key),
                getSortValue(right, sortState.key)
            );
            return comparison * direction ||
                left.question.id.localeCompare(right.question.id, 'es', { numeric: true });
        });

        updateSortButtons();
        renderRows(sortedRows);
    }

    function getSortValue(row, key) {
        if (key === 'id') return row.question.id;
        if (key === 'question') return row.question.question_text;
        if (key === 'task') return row.question.task_number;
        if (key === 'correct') return row.correct;
        if (key === 'incorrect') return row.incorrect;
        if (key === 'result') {
            if (row.lastCorrect === true) return 2;
            if (row.lastCorrect === false) return 1;
            return 0;
        }
        return row.attempts;
    }

    function compareValues(left, right) {
        if (typeof left === 'number' && typeof right === 'number') {
            return left - right;
        }
        return String(left).localeCompare(String(right), 'es', {
            numeric: true,
            sensitivity: 'base'
        });
    }

    function updateSortButtons() {
        ui.sortButtons.forEach(button => {
            const active = button.dataset.sort === sortState.key;
            button.classList.toggle('active', active);
            button.dataset.direction = active ? sortState.direction : '';
            button.setAttribute(
                'aria-label',
                `${button.textContent.replace(/[↕↑↓]/g, '').trim()}. ` +
                (active
                    ? `Orden ${sortState.direction === 'asc' ? 'ascendente' : 'descendente'}`
                    : 'Ordenar por esta columna')
            );
            button.querySelector('span').textContent = active
                ? (sortState.direction === 'asc' ? '↑' : '↓')
                : '↕';
        });
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
