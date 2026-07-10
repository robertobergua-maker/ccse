document.addEventListener('DOMContentLoaded', () => {
    const ADMIN_EMAIL = 'roberto.bergua@gmail.com';
    const DAY_MS = 24 * 60 * 60 * 1000;
    const WEEK_MS = 7 * DAY_MS;
    const LIMITS = {
        exams24hWatch: 8,
        exams24hDanger: 20,
        exams7dWatch: 30,
        exams7dDanger: 70
    };

    const auth = firebase.auth();
    const db = firebase.firestore();
    let adminUser = null;
    let currentRows = [];
    let extractedManualQuestions = [];
    let extractedManualYear = '';
    const ui = {
        summary: document.getElementById('admin-summary'),
        status: document.getElementById('admin-status'),
        users: document.getElementById('metric-users'),
        exams: document.getElementById('metric-exams'),
        exams24h: document.getElementById('metric-exams-24h'),
        alerts: document.getElementById('metric-alerts'),
        riskBody: document.getElementById('risk-body'),
        usersBody: document.getElementById('users-body'),
        activitySummary: document.getElementById('activity-summary'),
        activityBody: document.getElementById('activity-body'),
        manualPdfInput: document.getElementById('manual-pdf-input'),
        manualCheckBtn: document.getElementById('manual-check-btn'),
        manualUpdateBtn: document.getElementById('manual-update-btn'),
        manualCheckStatus: document.getElementById('manual-check-status'),
        manualCheckResults: document.getElementById('manual-check-results')
    };

    if (window.pdfjsLib) {
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }

    auth.onAuthStateChanged(user => {
        if (!user) return;
        if (String(user.email || '').toLowerCase() !== ADMIN_EMAIL) {
            ui.summary.textContent = 'Acceso restringido al administrador.';
            setStatus('Sin permiso', 'offline');
            setForbiddenTables();
            return;
        }
        adminUser = user;
        loadAdminData();
    });

    ui.usersBody.addEventListener('click', event => {
        const action = event.target.dataset.action;
        const userId = event.target.dataset.userId;
        if (!action || !userId) return;

        if (action === 'review') {
            reviewUserActivity(userId);
            return;
        }

        if (action === 'block') {
            setUserBlocked(userId, true);
            return;
        }

        if (action === 'unblock') {
            setUserBlocked(userId, false);
        }
    });

    ui.manualCheckBtn.addEventListener('click', () => {
        checkManualPdf();
    });

    ui.manualUpdateBtn.addEventListener('click', () => {
        updateQuestionDatabase();
    });

    async function loadAdminData() {
        try {
            const [usersSnapshot, examsSnapshot] = await Promise.all([
                db.collection('users').get(),
                db.collection('exams').get()
            ]);

            const users = [];
            const usersById = new Map();
            usersSnapshot.forEach(doc => {
                const user = { id: doc.id, ...doc.data() };
                users.push(user);
                usersById.set(doc.id, user);
            });

            const exams = [];
            examsSnapshot.forEach(doc => {
                exams.push({ id: doc.id, ...doc.data() });
            });

            const rows = buildUserRows(users, usersById, exams);
            currentRows = rows;
            renderMetrics(users, exams, rows);
            renderRiskRows(rows);
            renderUserRows(rows);
            setStatus('Activo', 'online');
        } catch (error) {
            console.error('No se pudo cargar el panel admin:', error);
            ui.summary.textContent = 'No se pudo cargar el panel administrador.';
            setStatus('Error', 'offline');
            ui.riskBody.innerHTML = '<tr><td colspan="6" class="empty-state">Error al cargar señales.</td></tr>';
            ui.usersBody.innerHTML = '<tr><td colspan="8" class="empty-state">Error al cargar usuarios.</td></tr>';
        }
    }

    function buildUserRows(users, usersById, exams) {
        const rowsByUser = new Map();

        users.forEach(user => {
            rowsByUser.set(user.id, {
                user,
                exams: [],
                total: 0,
                exams24h: 0,
                exams7d: 0,
                passed: 0,
                failed: 0,
                lastActivity: 0,
                risk: 'ok',
                notes: []
            });
        });

        exams.forEach(exam => {
            const userId = exam.user_id || 'sin_usuario';
            if (!rowsByUser.has(userId)) {
                const fallbackUser = usersById.get(userId) || {
                    id: userId,
                    name: 'Usuario sin perfil',
                    email: 'No disponible'
                };
                rowsByUser.set(userId, {
                    user: fallbackUser,
                    exams: [],
                    total: 0,
                    exams24h: 0,
                    exams7d: 0,
                    passed: 0,
                    failed: 0,
                    lastActivity: 0,
                    risk: 'ok',
                    notes: []
                });
            }

            const row = rowsByUser.get(userId);
            const finishedAt = timestampToMillis(exam.finished_at);
            row.exams.push(exam);
            row.total += 1;
            row.lastActivity = Math.max(row.lastActivity, finishedAt);
            if (exam.passed === true) row.passed += 1;
            else row.failed += 1;
        });

        const now = Date.now();
        rowsByUser.forEach(row => {
            row.exams24h = row.exams.filter(exam => now - timestampToMillis(exam.finished_at) <= DAY_MS).length;
            row.exams7d = row.exams.filter(exam => now - timestampToMillis(exam.finished_at) <= WEEK_MS).length;
            row.risk = getRisk(row);
            row.notes = getRiskNotes(row);
        });

        return [...rowsByUser.values()].sort((left, right) =>
            riskRank(right.risk) - riskRank(left.risk) ||
            right.exams24h - left.exams24h ||
            right.lastActivity - left.lastActivity
        );
    }

    function renderMetrics(users, exams, rows) {
        const now = Date.now();
        const exams24h = exams.filter(exam => now - timestampToMillis(exam.finished_at) <= DAY_MS).length;
        const alerts = rows.filter(row => row.risk !== 'ok').length;

        ui.users.textContent = users.length;
        ui.exams.textContent = exams.length;
        ui.exams24h.textContent = exams24h;
        ui.alerts.textContent = alerts;
        ui.summary.textContent = `${users.length} usuarios, ${exams.length} exámenes guardados, ${alerts} usuario${alerts === 1 ? '' : 's'} con señales de exceso.`;
    }

    function renderRiskRows(rows) {
        const riskyRows = rows.filter(row => row.risk !== 'ok');
        if (riskyRows.length === 0) {
            ui.riskBody.innerHTML = '<tr><td colspan="6" class="empty-state">Sin señales de exceso ahora mismo.</td></tr>';
            return;
        }

        ui.riskBody.innerHTML = riskyRows.map(row => `
            <tr>
                <td>
                    <strong>${escapeHtml(displayName(row.user))}</strong>
                    <p class="admin-notes">${escapeHtml(row.user.email || 'No disponible')}</p>
                    <p class="admin-notes">${escapeHtml(row.notes.join(' · '))}</p>
                </td>
                <td>${riskBadge(row.risk)}</td>
                <td><strong>${row.exams24h}</strong></td>
                <td>${row.exams7d}</td>
                <td>${row.total}</td>
                <td>${escapeHtml(formatDate(row.lastActivity))}</td>
            </tr>
        `).join('');
    }

    function renderUserRows(rows) {
        if (rows.length === 0) {
            ui.usersBody.innerHTML = '<tr><td colspan="8" class="empty-state">No hay usuarios registrados.</td></tr>';
            return;
        }

        ui.usersBody.innerHTML = rows.map(row => `
            <tr>
                <td><strong>${escapeHtml(displayName(row.user))}</strong></td>
                <td>${escapeHtml(row.user.email || 'No disponible')}</td>
                <td>${escapeHtml(formatTimestamp(row.user.created_at))}</td>
                <td>${escapeHtml(formatTimestamp(row.user.last_login))}</td>
                <td>${userStatusBadge(row.user)}</td>
                <td>${row.passed}</td>
                <td>${row.failed}</td>
                <td>
                    <div class="admin-actions">
                        <button class="btn btn-secondary btn-compact" data-action="review" data-user-id="${escapeHtml(row.user.id)}" type="button">Revisar</button>
                        ${blockButton(row.user)}
                    </div>
                </td>
            </tr>
        `).join('');
    }

    async function setUserBlocked(userId, blocked) {
        const row = currentRows.find(item => item.user.id === userId);
        if (!row) return;

        const userLabel = displayName(row.user);
        const verb = blocked ? 'bloquear' : 'desbloquear';
        const confirmed = confirm(`¿Quieres ${verb} a ${userLabel}?`);
        if (!confirmed) return;

        try {
            const update = blocked
                ? {
                    blocked: true,
                    blocked_at: firebase.firestore.FieldValue.serverTimestamp(),
                    blocked_by: adminUser.email,
                    blocked_reason: 'Bloqueado desde panel administrador'
                }
                : {
                    blocked: false,
                    unblocked_at: firebase.firestore.FieldValue.serverTimestamp(),
                    unblocked_by: adminUser.email
                };

            await db.collection('users').doc(userId).update(update);
            await loadAdminData();
            reviewUserActivity(userId);
        } catch (error) {
            console.error(`No se pudo ${verb} el usuario:`, error);
            alert(`No se pudo ${verb} el usuario. Revisa permisos o conexión.`);
        }
    }

    async function reviewUserActivity(userId) {
        const row = currentRows.find(item => item.user.id === userId);
        if (!row) return;

        ui.activitySummary.textContent = `Cargando actividad de ${displayName(row.user)}…`;
        ui.activityBody.innerHTML = '<tr><td colspan="6" class="empty-state">Cargando actividad…</td></tr>';

        try {
            const answersSnapshot = await db.collection('exam_answers')
                .where('user_id', '==', userId)
                .get();
            const answersByExam = new Map();
            answersSnapshot.forEach(doc => {
                const answer = doc.data();
                const examId = answer.exam_id || 'sin_examen';
                if (!answersByExam.has(examId)) answersByExam.set(examId, []);
                answersByExam.get(examId).push(answer);
            });

            const exams = [...row.exams].sort(
                (left, right) => timestampToMillis(right.finished_at) - timestampToMillis(left.finished_at)
            );
            ui.activitySummary.textContent =
                `${displayName(row.user)} · ${row.total} exámenes · ${answersSnapshot.size} respuestas registradas · ${row.exams24h} exámenes en 24 h.`;

            if (exams.length === 0) {
                ui.activityBody.innerHTML = '<tr><td colspan="6" class="empty-state">Este usuario no tiene exámenes guardados.</td></tr>';
                return;
            }

            ui.activityBody.innerHTML = exams.map(exam => {
                const answers = answersByExam.get(exam.id) || [];
                const questionIds = answers.map(answer => answer.question_id).filter(Boolean);
                return `
                    <tr>
                        <td>${escapeHtml(formatTimestamp(exam.finished_at))}</td>
                        <td>${exam.passed ? '<span class="result-badge result-correct">Apto</span>' : '<span class="result-badge result-wrong">No apto</span>'}</td>
                        <td>${exam.score_correct || 0}/${exam.total_questions || 25}</td>
                        <td>${exam.score_incorrect || 0}</td>
                        <td>${exam.score_unanswered || 0}</td>
                        <td>
                            <strong>${answers.length}</strong>
                            <p class="admin-notes">${escapeHtml(questionIds.slice(0, 12).join(', ') || 'Sin detalle')}</p>
                        </td>
                    </tr>
                `;
            }).join('');
        } catch (error) {
            console.error('No se pudo cargar la actividad del usuario:', error);
            ui.activitySummary.textContent = `No se pudo cargar la actividad de ${displayName(row.user)}.`;
            ui.activityBody.innerHTML = '<tr><td colspan="6" class="empty-state">Error al cargar actividad.</td></tr>';
        }
    }

    function getRisk(row) {
        if (row.exams24h >= LIMITS.exams24hDanger || row.exams7d >= LIMITS.exams7dDanger) return 'danger';
        if (row.exams24h >= LIMITS.exams24hWatch || row.exams7d >= LIMITS.exams7dWatch) return 'watch';
        return 'ok';
    }

    function getRiskNotes(row) {
        const notes = [];
        if (row.exams24h >= LIMITS.exams24hDanger) notes.push('Volumen crítico en 24 h');
        else if (row.exams24h >= LIMITS.exams24hWatch) notes.push('Uso alto en 24 h');
        if (row.exams7d >= LIMITS.exams7dDanger) notes.push('Volumen crítico en 7 días');
        else if (row.exams7d >= LIMITS.exams7dWatch) notes.push('Uso alto en 7 días');
        return notes.length ? notes : ['Actividad normal'];
    }

    function riskBadge(risk) {
        if (risk === 'danger') return '<span class="risk-badge risk-danger">Crítico</span>';
        if (risk === 'watch') return '<span class="risk-badge risk-watch">Vigilar</span>';
        return '<span class="risk-badge risk-ok">Normal</span>';
    }

    function userStatusBadge(user) {
        if (user.blocked === true) return '<span class="risk-badge risk-danger">Bloqueado</span>';
        return '<span class="risk-badge risk-ok">Activo</span>';
    }

    function blockButton(user) {
        if (String(user.email || '').toLowerCase() === ADMIN_EMAIL) {
            return '<span class="admin-notes">Admin</span>';
        }

        if (user.blocked === true) {
            return `<button class="btn btn-primary btn-compact" data-action="unblock" data-user-id="${escapeHtml(user.id)}" type="button">Desbloquear</button>`;
        }

        return `<button class="btn btn-danger btn-compact" data-action="block" data-user-id="${escapeHtml(user.id)}" type="button">Bloquear</button>`;
    }

    async function checkManualPdf() {
        if (!adminUser) {
            alert('Esta comprobación solo está disponible para el administrador.');
            return;
        }

        const file = ui.manualPdfInput.files[0];
        if (!file) {
            alert('Selecciona primero el PDF del manual.');
            return;
        }

        if (!window.pdfjsLib) {
            setManualCheckStatus('Sin PDF.js', 'offline');
            ui.manualCheckResults.innerHTML =
                '<p class="error-message">No se pudo cargar el lector PDF del navegador.</p>';
            return;
        }

        setManualCheckStatus('Leyendo PDF…', 'online');
        ui.manualCheckBtn.disabled = true;
        ui.manualUpdateBtn.disabled = true;
        ui.manualCheckResults.innerHTML =
            '<p class="empty-state">Extrayendo texto del manual. Puede tardar unos segundos…</p>';

        try {
            const [currentQuestions, pdfPages] = await Promise.all([
                loadQuestionBank(),
                extractPdfPages(file)
            ]);

            const parsed = extractQuestionsFromManual(pdfPages);
            validateExtractedQuestions(parsed.questions, parsed.answersFound);
            extractedManualQuestions = parsed.questions;
            extractedManualYear = parsed.manualYear;

            const report = buildManualReport(currentQuestions, parsed.questions, file.name, parsed.manualYear);
            renderManualReport(report);
            ui.manualUpdateBtn.disabled = false;
            setManualCheckStatus(report.isOk ? 'Actualizado' : 'Revisar', report.isOk ? 'online' : 'offline');
        } catch (error) {
            console.error('No se pudo comprobar el manual:', error);
            extractedManualQuestions = [];
            extractedManualYear = '';
            setManualCheckStatus('Error', 'offline');
            ui.manualCheckResults.innerHTML =
                `<p class="error-message">${escapeHtml(error.message)}</p>`;
        } finally {
            ui.manualCheckBtn.disabled = false;
        }
    }

    async function updateQuestionDatabase() {
        if (!adminUser || extractedManualQuestions.length !== 300) {
            alert('Primero comprueba un PDF válido con 300 preguntas.');
            return;
        }

        const confirmed = confirm(
            `Vas a reemplazar la colección questions con ${extractedManualQuestions.length} preguntas del manual ${extractedManualYear || 'seleccionado'}. ¿Continuar?`
        );
        if (!confirmed) return;

        ui.manualUpdateBtn.disabled = true;
        ui.manualCheckBtn.disabled = true;
        setManualCheckStatus('Actualizando…', 'online');

        try {
            const existingSnapshot = await db.collection('questions').get();
            const newIds = new Set(extractedManualQuestions.map(question => question.id));
            const operations = [];

            existingSnapshot.forEach(doc => {
                if (!newIds.has(doc.id)) {
                    operations.push({ type: 'delete', ref: doc.ref });
                }
            });

            extractedManualQuestions.forEach(question => {
                const ref = db.collection('questions').doc(question.id);
                operations.push({
                    type: 'set',
                    ref,
                    data: {
                    ...question,
                    updated_at: firebase.firestore.FieldValue.serverTimestamp(),
                    updated_by: adminUser.email
                    }
                });
            });

            await commitOperationsInChunks(operations);
            setManualCheckStatus('BBDD actualizada', 'online');
            ui.manualCheckResults.insertAdjacentHTML(
                'afterbegin',
                `<p class="result-badge result-correct">Base de datos actualizada: ${extractedManualQuestions.length} preguntas activas en Firestore.</p>`
            );
        } catch (error) {
            console.error('No se pudo actualizar la BBDD de preguntas:', error);
            setManualCheckStatus('Error', 'offline');
            alert('No se pudo actualizar la BBDD. Revisa permisos o conexión.');
        } finally {
            ui.manualCheckBtn.disabled = false;
        }
    }

    async function commitOperationsInChunks(operations) {
        const chunkSize = 450;
        for (let index = 0; index < operations.length; index += chunkSize) {
            const batch = db.batch();
            operations.slice(index, index + chunkSize).forEach(operation => {
                if (operation.type === 'delete') {
                    batch.delete(operation.ref);
                } else {
                    batch.set(operation.ref, operation.data);
                }
            });
            await batch.commit();
        }
    }

    async function extractPdfPages(file) {
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        const pages = [];

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            pages.push(textItemsToLines(content.items));
        }

        return pages;
    }

    function textItemsToLines(items) {
        const textItems = items
            .filter(item => String(item.str || '').trim())
            .map(item => ({
                x: item.transform?.[4] || 0,
                y: item.transform?.[5] || 0,
                text: item.str
            }));
        if (textItems.length === 0) return '';

        const minX = Math.min(...textItems.map(item => item.x));
        const maxX = Math.max(...textItems.map(item => item.x));
        const columnBreak = minX + ((maxX - minX) * 0.52);
        const hasTwoColumns = textItems.filter(item => item.x > columnBreak).length > 12;
        const groups = hasTwoColumns
            ? [
                textItems.filter(item => item.x <= columnBreak),
                textItems.filter(item => item.x > columnBreak)
            ]
            : [textItems];

        return groups
            .map(group => textGroupToLines(group))
            .filter(Boolean)
            .join('\n');
    }

    function textGroupToLines(items) {
        const rows = [];
        const tolerance = 2;

        items.forEach(item => {
            const { x, y, text } = item;
            let row = rows.find(candidate => Math.abs(candidate.y - y) <= tolerance);

            if (!row) {
                row = { y, items: [] };
                rows.push(row);
            }

            row.items.push({ x, text });
        });

        return rows
            .sort((left, right) => right.y - left.y)
            .map(row => row.items
                .sort((left, right) => left.x - right.x)
                .map(item => item.text)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim()
            )
            .filter(Boolean)
            .join('\n');
    }

    async function loadQuestionBank() {
        try {
            const snapshot = await db.collection('questions').get();
            const questions = [];
            snapshot.forEach(doc => questions.push({ id: doc.id, ...doc.data() }));
            if (questions.length > 0) {
                return questions
                    .filter(question => question.active !== false)
                    .sort((left, right) => String(left.id).localeCompare(String(right.id), 'es', { numeric: true }));
            }
        } catch (error) {
            console.warn('No se pudo leer questions en Firestore. Se usará preguntas.json.', error);
        }

        const response = await fetch('preguntas.json', { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`No se pudo cargar preguntas.json (${response.status})`);
        }
        return (await response.json()).filter(question => question.active !== false);
    }

    function buildManualReport(currentQuestions, manualQuestions, fileName, manualYear) {
        const manualById = new Map(manualQuestions.map(question => [question.id, question]));
        const questionIssues = [];
        const optionIssues = [];
        const missingCodes = [];
        const addedCodes = manualQuestions
            .filter(question => !currentQuestions.some(current => current.id === question.id))
            .map(question => question.id);

        currentQuestions.forEach(question => {
            const manualQuestion = manualById.get(question.id);
            if (!manualQuestion) {
                missingCodes.push(question.id);
                return;
            }

            if (!sameNormalizedText(question.question_text, manualQuestion.question_text)) {
                questionIssues.push({
                    id: question.id,
                    text: question.question_text,
                    newText: manualQuestion.question_text
                });
            }

            question.options.forEach(option => {
                const manualOption = manualQuestion.options.find(candidate => candidate.key === option.key);
                if (!manualOption || !sameNormalizedText(option.text, manualOption.text)) {
                    optionIssues.push({
                        id: question.id,
                        option: option.key.toUpperCase(),
                        text: option.text,
                        newText: manualOption ? manualOption.text : 'No disponible'
                    });
                }
            });

            if (question.correct_answer !== manualQuestion.correct_answer) {
                optionIssues.push({
                    id: question.id,
                    option: 'Correcta',
                    text: question.correct_answer,
                    newText: manualQuestion.correct_answer
                });
            }
        });

        return {
            fileName,
            manualYear,
            totalQuestions: currentQuestions.length,
            extractedQuestions: manualQuestions.length,
            missingCodes,
            addedCodes,
            questionIssues,
            optionIssues,
            isOk: currentQuestions.length === 300 &&
                manualQuestions.length === 300 &&
                missingCodes.length === 0 &&
                addedCodes.length === 0 &&
                questionIssues.length === 0 &&
                optionIssues.length === 0
        };
    }

    function renderManualReport(report) {
        const status = report.isOk
            ? '<span class="risk-badge risk-ok">Banco alineado con el PDF</span>'
            : '<span class="risk-badge risk-danger">Hay diferencias que revisar</span>';

        ui.manualCheckResults.innerHTML = `
            <div class="admin-check-grid">
                <div class="admin-card"><span>PDF</span><strong>${escapeHtml(report.fileName)}</strong></div>
                <div class="admin-card"><span>Año detectado</span><strong>${escapeHtml(report.manualYear || 'No detectado')}</strong></div>
                <div class="admin-card"><span>Banco / PDF</span><strong>${report.totalQuestions}/${report.extractedQuestions}</strong></div>
                <div class="admin-card"><span>Estado</span><strong>${status}</strong></div>
            </div>
            ${renderIssueBlock('Códigos del banco que no están en el PDF', report.missingCodes)}
            ${renderIssueBlock('Códigos nuevos en el PDF', report.addedCodes)}
            ${renderQuestionIssueBlock('Enunciados distintos', report.questionIssues)}
            ${renderOptionIssueBlock('Opciones o respuestas distintas', report.optionIssues)}
            <p class="admin-notes">El PDF se procesa en este navegador y no se sube ni se guarda en Firestore.</p>
        `;
    }

    function renderIssueBlock(title, values) {
        if (values.length === 0) {
            return `<h3>${escapeHtml(title)}</h3><p class="admin-notes">Sin incidencias.</p>`;
        }

        return `
            <h3>${escapeHtml(title)} (${values.length})</h3>
            <ul class="admin-check-list">
                ${values.slice(0, 40).map(value => `<li>${escapeHtml(value)}</li>`).join('')}
            </ul>
            ${values.length > 40 ? `<p class="admin-notes">Se muestran 40 de ${values.length} incidencias.</p>` : ''}
        `;
    }

    function renderQuestionIssueBlock(title, issues) {
        if (issues.length === 0) {
            return `<h3>${escapeHtml(title)}</h3><p class="admin-notes">Sin incidencias.</p>`;
        }

        return `
            <h3>${escapeHtml(title)} (${issues.length})</h3>
            <ul class="admin-check-list">
                ${issues.slice(0, 20).map(issue =>
                    `<li><strong>${escapeHtml(issue.id)}</strong>: ${escapeHtml(issue.text)} → ${escapeHtml(issue.newText)}</li>`
                ).join('')}
            </ul>
            ${issues.length > 20 ? `<p class="admin-notes">Se muestran 20 de ${issues.length} incidencias.</p>` : ''}
        `;
    }

    function renderOptionIssueBlock(title, issues) {
        if (issues.length === 0) {
            return `<h3>${escapeHtml(title)}</h3><p class="admin-notes">Sin incidencias.</p>`;
        }

        return `
            <h3>${escapeHtml(title)} (${issues.length})</h3>
            <ul class="admin-check-list">
                ${issues.slice(0, 30).map(issue =>
                    `<li><strong>${escapeHtml(issue.id)} ${escapeHtml(issue.option)}</strong>: ${escapeHtml(issue.text)} → ${escapeHtml(issue.newText)}</li>`
                ).join('')}
            </ul>
            ${issues.length > 30 ? `<p class="admin-notes">Se muestran 30 de ${issues.length} incidencias.</p>` : ''}
        `;
    }

    function extractQuestionsFromManual(pdfPages) {
        const pageText = pdfPages.join('\n');
        const manualYear = detectManualYear(pageText);
        const answerStart = findAnswerStartPage(pdfPages);
        const answers = extractAnswerMap(pdfPages.slice(answerStart).join('\n'));
        const questionText = pdfPages.slice(0, answerStart).join('\n');
        const byId = new Map();

        [1, 2, 3, 4, 5].forEach(taskNumber => {
            extractTaskQuestions(questionText, taskNumber, answers, manualYear)
                .forEach(question => byId.set(question.id, question));
        });

        return {
            questions: [...byId.values()].sort((left, right) =>
                left.id.localeCompare(right.id, 'es', { numeric: true })
            ),
            manualYear,
            answersFound: answers.size
        };
    }

    function findAnswerStartPage(pdfPages) {
        let bestIndex = 92;
        let bestCount = 0;

        pdfPages.forEach((_, index) => {
            const count = extractAnswerMap(pdfPages.slice(index, Math.min(index + 10, pdfPages.length)).join('\n')).size;
            if (count > bestCount) {
                bestCount = count;
                bestIndex = index;
            }
        });

        return bestCount >= 250 ? bestIndex : 92;
    }

    function extractTaskQuestions(rawText, taskNumber, answers, manualYear) {
        const markers = [...rawText.matchAll(new RegExp(`\\b(${taskNumber}\\d{3})\\b\\s*`, 'g'))]
            .filter(marker => answers.has(marker[1]));
        const questions = [];

        markers.forEach((marker, index) => {
            const id = marker[1];
            const nextMarker = markers[index + 1];
            const block = cleanPdfText(rawText.slice(marker.index + marker[0].length, nextMarker ? nextMarker.index : rawText.length));
            const labels = findOptionLabels(block);
            const expectedOptions = taskNumber === 2 ? 2 : 3;

            if (labels.length < expectedOptions || !answers.has(id)) return;

            const selectedLabels = labels.slice(0, expectedOptions);
            const questionText = cleanQuestionText(block.slice(0, selectedLabels[0].index));
            if (!questionText || questionText.length < 4) return;

            const options = selectedLabels.map((label, optionIndex) => {
                const start = label.end;
                const end = selectedLabels[optionIndex + 1]?.index ?? block.length;
                return {
                    key: label.key,
                    text: cleanOptionText(block.slice(start, end))
                };
            });

            if (options.some(option => !option.text)) return;

            questions.push({
                id,
                code: id,
                task_number: taskNumber,
                topic: taskTopic(taskNumber),
                question_text: questionText,
                question_type: taskNumber === 2 ? 'true_false' : 'multiple_choice',
                options,
                correct_answer: answers.get(id),
                active: true,
                source: `Manual CCSE ${manualYear || 'Cervantes'}`
            });
        });

        return questions;
    }

    function findOptionLabels(block) {
        return [...block.matchAll(/(?:^|\s)([abc])[\).]\s*/gi)].map(match => ({
            index: match.index,
            end: match.index + match[0].length,
            key: match[1].toLowerCase()
        }));
    }

    function extractAnswerMap(text) {
        return new Map(
            [...text.matchAll(/\b([1-5]\d{3})\s+([abc])\b/gi)]
                .map(match => [match[1], match[2].toLowerCase()])
        );
    }

    function validateExtractedQuestions(questions, answersFound = null) {
        if (questions.length !== 300) {
            const answerNote = answersFound === null ? '' : ` Respuestas detectadas: ${answersFound}.`;
            throw new Error(`El PDF debe permitir extraer 300 preguntas y se han extraído ${questions.length}.${answerNote}`);
        }

        const expected = { 1: 120, 2: 36, 3: 24, 4: 36, 5: 84 };
        Object.entries(expected).forEach(([task, amount]) => {
            const found = questions.filter(question => question.task_number === Number(task)).length;
            if (found !== amount) {
                throw new Error(`La tarea ${task} debe tener ${amount} preguntas y se han extraído ${found}.`);
            }
        });

        questions.forEach(question => {
            if (!question.options.some(option => option.key === question.correct_answer)) {
                throw new Error(`La pregunta ${question.id} tiene una respuesta correcta no disponible.`);
            }
        });
    }

    function cleanPdfText(value) {
        return String(value || '')
            .replace(/\bPREGUNTAS PARA LA TAREA \d\b/gi, '')
            .split('\n')
            .map(line => line.trim())
            .filter(line => !/^\d{1,3}$/.test(line))
            .filter(line => !/^Instituto Cervantes\b/i.test(line))
            .filter(line => !/^Manual de preparación\b/i.test(line))
            .filter(line => !/^SATNUGERP$/.test(line))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function cleanQuestionText(value) {
        return cleanPdfText(value)
            .replace(/^\d{1,3}\s+/, '')
            .replace(/\s+$/, '');
    }

    function cleanOptionText(value) {
        return cleanPdfText(value)
            .replace(/\b[1-5]\d{3}\b[\s\S]*$/, '')
            .trim();
    }

    function taskTopic(taskNumber) {
        const topics = {
            1: 'Gobierno, legislación y participación ciudadana',
            2: 'Derechos y deberes fundamentales',
            3: 'Organización territorial de España. Geografía física y política',
            4: 'Cultura e historia de España',
            5: 'Sociedad española'
        };
        return topics[taskNumber] || 'Manual CCSE';
    }

    function sameNormalizedText(left, right) {
        return normalizeForSearch(left) === normalizeForSearch(right);
    }

    function detectManualYear(text) {
        const matches = [...text.matchAll(/\b20\d{2}\b/g)].map(match => match[0]);
        const counts = matches.reduce((accumulator, year) => {
            accumulator[year] = (accumulator[year] || 0) + 1;
            return accumulator;
        }, {});
        return Object.entries(counts)
            .sort((left, right) => right[1] - left[1])
            .map(([year]) => year)[0] || '';
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

    function setManualCheckStatus(text, state) {
        ui.manualCheckStatus.textContent = text;
        ui.manualCheckStatus.className = `status-badge status-${state}`;
    }

    function setForbiddenTables() {
        ui.riskBody.innerHTML = '<tr><td colspan="6" class="empty-state">No tienes permiso para ver este panel.</td></tr>';
        ui.usersBody.innerHTML = '<tr><td colspan="8" class="empty-state">No tienes permiso para ver usuarios.</td></tr>';
        ui.activityBody.innerHTML = '<tr><td colspan="6" class="empty-state">No tienes permiso para ver actividad.</td></tr>';
    }

    function setStatus(text, state) {
        ui.status.textContent = text;
        ui.status.className = `status-badge status-${state}`;
    }

    function displayName(user) {
        return user.name || user.email || user.id || 'Usuario';
    }

    function timestampToMillis(timestamp) {
        if (!timestamp) return 0;
        if (typeof timestamp.toMillis === 'function') return timestamp.toMillis();
        if (timestamp.seconds) return timestamp.seconds * 1000;
        return 0;
    }

    function formatTimestamp(timestamp) {
        return formatDate(timestampToMillis(timestamp));
    }

    function formatDate(millis) {
        if (!millis) return 'Sin fecha';
        return new Intl.DateTimeFormat('es-ES', {
            dateStyle: 'short',
            timeStyle: 'short'
        }).format(new Date(millis));
    }

    function riskRank(risk) {
        if (risk === 'danger') return 2;
        if (risk === 'watch') return 1;
        return 0;
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
