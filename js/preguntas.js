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
        downloadCsvBtn: document.getElementById('download-questions-csv'),
        sortButtons: [...document.querySelectorAll('.sort-button')]
    };
    let visibleRows = [];
    let displayedRows = [];
    let sortState = { key: 'attempts', direction: 'desc' };

    ui.title.textContent = labels[activeFilter];
    document.querySelectorAll('.filter-nav a').forEach(link => {
        const linkFilter = new URL(link.href).searchParams.get('filtro');
        link.classList.toggle('active', linkFilter === activeFilter);
    });

    auth.onAuthStateChanged(async user => {
        if (!user) return;

        try {
            const [questions, statsSnapshot] = await Promise.all([
                loadQuestionBank(),
                db.collection('user_question_stats')
                    .where('user_id', '==', user.uid)
                    .get()
            ]);
            const validQuestionTexts = new Set(questions.map(question => normalizeForSearch(question.question_text)));
            const currentTextByQuestion = new Map(
                questions.map(question => [question.id, normalizeForSearch(question.question_text)])
            );
            const statsByQuestion = new Map();
            const obsoleteStats = [];

            statsSnapshot.forEach(doc => {
                const stat = doc.data();
                const statText = normalizeForSearch(stat.question_text);
                if (!statText || !validQuestionTexts.has(statText)) {
                    obsoleteStats.push(doc.ref);
                    return;
                }
                if (currentTextByQuestion.get(stat.question_id) === statText) {
                    statsByQuestion.set(stat.question_id, stat);
                }
            });
            await cleanupObsoleteStats(obsoleteStats);

            visibleRows = questions.map(question => {
                const stat = statsByQuestion.get(question.id) || {};
                let lastFailedAt = stat.last_failed_at || null;
                if (!lastFailedAt && stat.last_correct === false && stat.last_answered_at) {
                    lastFailedAt = stat.last_answered_at;
                }

                return {
                    question,
                    attempts: stat.total_attempts || 0,
                    correct: stat.total_correct || 0,
                    incorrect: stat.total_incorrect || 0,
                    lastCorrect: typeof stat.last_correct === 'boolean' ? stat.last_correct : null,
                    lastAnswer: stat.last_answer || null,
                    lastFailedAt: lastFailedAt
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
    ui.downloadCsvBtn?.addEventListener('click', downloadQuestionsCsv);

    function matchesFilter(row) {
        if (activeFilter === 'respondidas') return row.attempts > 0;
        if (activeFilter === 'no-respondidas') return row.attempts === 0;
        if (activeFilter === 'acertadas') return row.lastCorrect === true;
        if (activeFilter === 'falladas') return row.lastCorrect === false;
        return true;
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
        const localQuestions = await loadLocalQuestionBank();

        try {
            const snapshot = await db.collection('questions').get();
            const questions = [];
            snapshot.forEach(doc => questions.push({ id: doc.id, ...doc.data() }));
            if (questions.length > 0) {
                const localById = new Map(localQuestions.map(question => [String(question.id), question]));
                return sortQuestions(questions.map(question => {
                    const local = localById.get(String(question.id)) || {};
                    return {
                        ...local,
                        ...question,
                        explicacion_facil: local.explicacion_facil || question.explicacion_facil || ''
                    };
                }).filter(question => question.active !== false));
            }
        } catch (error) {
            console.warn('No se pudo cargar questions desde Firestore. Se usará preguntas.json.', error);
        }

        return sortQuestions(localQuestions.filter(question => question.active !== false));
    }

    async function loadLocalQuestionBank() {
        const response = await fetch('preguntas.json', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`No se pudo cargar el banco (${response.status})`);
        }
        return await response.json();
    }

    function sortQuestions(questions) {
        return questions.sort((left, right) =>
            String(left.id).localeCompare(String(right.id), 'es', { numeric: true })
        );
    }

    function renderRows(rows) {
        if (rows.length === 0) {
            ui.body.innerHTML = '<tr><td colspan="7" class="empty-state">No hay preguntas en esta categoría.</td></tr>';
            return;
        }

        ui.body.innerHTML = rows.map(row => {
            const correctOption = getOption(row.question, row.question.correct_answer);
            const lastOption = getOption(row.question, row.lastAnswer);
            const questionText = getContextualQuestionText(row.question, correctOption);

            const isFailed = row.lastCorrect === false || (activeFilter === 'falladas' && row.incorrect > 0);
            const explanation = isFailed ? getEasyExplanation(row.question, correctOption) : '';

            const explanationBox = isFailed ? `
                <div class="why-box">
                    <span class="why-title">Auditoría explicada</span>
                    <p>${escapeHtml(explanation)}</p>
                </div>
            ` : '';

            const answerContext = `
                <div class="question-context">
                    <span class="answer-correct">Correcta: ${escapeHtml(formatOption(correctOption))}</span>
                    ${lastOption ? `<span>Tu última respuesta: ${escapeHtml(formatOption(lastOption))}</span>` : ''}
                    ${explanationBox}
                </div>
            `;

            let result = '<span class="result-badge result-pending">Sin responder</span>';
            if (row.lastCorrect === true) {
                result = '<span class="result-badge result-correct">Acierto</span>';
            } else if (row.lastCorrect === false) {
                const dateText = row.lastFailedAt ? formatDate(row.lastFailedAt) : null;
                result = `
                    <span class="result-badge result-wrong">Fallo</span>
                    ${dateText ? `<div class="last-failed-badge" title="Fecha del último fallo">📅 ${escapeHtml(dateText)}</div>` : ''}
                `;
            }

            return `
                <tr>
                    <td><strong>${escapeHtml(row.question.id)}</strong></td>
                    <td>
                        <strong>${escapeHtml(questionText)}</strong>
                        ${answerContext}
                    </td>
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
        displayedRows = sortedRows;
        renderRows(sortedRows);
        if (ui.downloadCsvBtn) ui.downloadCsvBtn.disabled = sortedRows.length === 0;
    }

    function downloadQuestionsCsv() {
        const rows = displayedRows.map(row => {
            const correctOption = getOption(row.question, row.question.correct_answer);
            const lastOption = getOption(row.question, row.lastAnswer);
            const result = row.lastCorrect === true
                ? 'Acierto'
                : row.lastCorrect === false
                    ? 'Fallo'
                    : 'Sin responder';

            return {
                codigo: row.question.id,
                pregunta: getContextualQuestionText(row.question, correctOption),
                tarea: row.question.task_number,
                veces_respondida: row.attempts,
                aciertos: row.correct,
                fallos: row.incorrect,
                ultimo_resultado: result,
                respuesta_correcta: formatOption(correctOption),
                ultima_respuesta: lastOption ? formatOption(lastOption) : ''
            };
        });

        downloadCsv(`preguntas-${activeFilter}-${formatDateSlug(new Date())}.csv`, rows);
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

    function getOption(question, key) {
        if (!key) return null;
        return question.options.find(option => option.key === key) || null;
    }

    function formatOption(option) {
        return option
            ? `${option.key.toUpperCase()}) ${option.text}`
            : 'No disponible';
    }

    function getContextualQuestionText(question, correctOption) {
        const text = String(question.question_text || '').trim();
        if (!correctOption || !/(?:…|\.\.\.)\s*$/.test(text)) {
            return text;
        }

        const stem = text.replace(/(?:…|\.\.\.)\s*$/, '').trim();
        const answer = lowercaseFirst(cleanSentence(correctOption.text));
        const separator = /[\s¿¡]$/.test(stem) ? '' : ' ';

        return cleanSentence(`${stem}${separator}${answer}`) + '.';
    }

    function cleanSentence(value) {
        return String(value).trim().replace(/[.\s]+$/, '');
    }

    function lowercaseFirst(value) {
        if (!value) return value;
        if (/^[A-ZÁÉÍÓÚÑ]{2,}\b/.test(value)) return value;
        return value.charAt(0).toLowerCase() + value.slice(1);
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

    function downloadCsv(fileName, rows) {
        if (rows.length === 0) return;
        const headers = Object.keys(rows[0]);
        const csv = [
            headers.join(','),
            ...rows.map(row => headers.map(header => csvCell(row[header])).join(','))
        ].join('\r\n');
        const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function csvCell(value) {
        return `"${String(value ?? '').replace(/"/g, '""')}"`;
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

    function formatDate(timestamp) {
        if (!timestamp) return 'No disponible';
        let millis = 0;
        if (typeof timestamp.toMillis === 'function') millis = timestamp.toMillis();
        else if (timestamp.seconds) millis = timestamp.seconds * 1000;
        else if (typeof timestamp === 'number') millis = timestamp;
        else if (timestamp instanceof Date) millis = timestamp.getTime();
        else if (typeof timestamp === 'string') millis = new Date(timestamp).getTime();

        if (!millis || isNaN(millis)) return 'No disponible';

        return new Intl.DateTimeFormat('es-ES', {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(new Date(millis));
    }

    function formatDateSlug(date) {
        return date.toISOString().slice(0, 10);
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
