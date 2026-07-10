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
    let lastManualReport = null;

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
        manualCsvInput: document.getElementById('manual-csv-input'),
        manualCsvCheckBtn: document.getElementById('manual-csv-check-btn'),
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
        if (action === 'review') reviewUserActivity(userId);
        if (action === 'block') setUserBlocked(userId, true);
        if (action === 'unblock') setUserBlocked(userId, false);
    });

    ui.manualCheckBtn?.addEventListener('click', checkManualPdf);
    ui.manualCsvCheckBtn?.addEventListener('click', checkManualCsv);
    ui.manualUpdateBtn?.addEventListener('click', updateQuestionDatabase);

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
            examsSnapshot.forEach(doc => exams.push({ id: doc.id, ...doc.data() }));

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
                rowsByUser.set(userId, {
                    user: usersById.get(userId) || { id: userId, name: 'Usuario sin perfil', email: 'No disponible' },
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
        const verb = blocked ? 'bloquear' : 'desbloquear';
        if (!confirm(`¿Quieres ${verb} a ${displayName(row.user)}?`)) return;

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
        ui.activitySummary.textContent = `Cargando actividad de ${displayName(row.user)}...`;
        ui.activityBody.innerHTML = '<tr><td colspan="6" class="empty-state">Cargando actividad...</td></tr>';

        try {
            const answersSnapshot = await db.collection('exam_answers').where('user_id', '==', userId).get();
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

    async function checkManualPdf() {
        if (!adminUser) return alert('Esta comprobación solo está disponible para el administrador.');
        const file = ui.manualPdfInput.files[0];
        if (!file) return alert('Selecciona primero el PDF del manual.');
        if (!window.pdfjsLib) {
            setManualCheckStatus('Sin PDF.js', 'offline');
            ui.manualCheckResults.innerHTML = '<p class="error-message">No se pudo cargar el lector PDF del navegador.</p>';
            return;
        }

        resetImportState('Leyendo PDF...');
        ui.manualCheckBtn.disabled = true;
        try {
            const [currentQuestions, pdfPages] = await Promise.all([loadQuestionBank(), extractPdfPages(file)]);
            const parsed = extractQuestionsFromManual(pdfPages);
            validateExtractedQuestions(parsed.questions, parsed.answersFound, parsed.missingCodes, 'PDF');
            showImportReport(currentQuestions, parsed.questions, file.name, parsed.manualYear || '');
        } catch (error) {
            showImportError(error);
        } finally {
            ui.manualCheckBtn.disabled = false;
        }
    }

    async function checkManualCsv() {
        if (!adminUser) return alert('Esta comprobación solo está disponible para el administrador.');
        const file = ui.manualCsvInput.files[0];
        if (!file) return alert('Selecciona primero el fichero CSV.');

        resetImportState('Procesando CSV...');
        ui.manualCsvCheckBtn.disabled = true;
        try {
            const [currentQuestions, text] = await Promise.all([loadQuestionBank(), file.text()]);
            const parsed = parseCsvQuestions(text);
            validateExtractedQuestions(parsed.questions, parsed.answersFound, parsed.missingCodes, 'CSV');
            showImportReport(currentQuestions, parsed.questions, file.name, parsed.manualYear || '2026');
        } catch (error) {
            showImportError(error);
        } finally {
            ui.manualCsvCheckBtn.disabled = false;
        }
    }

    function resetImportState(statusText) {
        extractedManualQuestions = [];
        extractedManualYear = '';
        lastManualReport = null;
        ui.manualUpdateBtn.disabled = true;
        ui.manualUpdateBtn.textContent = 'Corregir BBDD';
        setManualCheckStatus(statusText, 'online');
        ui.manualCheckResults.innerHTML = '<p class="empty-state">Leyendo y comparando preguntas...</p>';
    }

    function showImportReport(currentQuestions, importedQuestions, fileName, manualYear) {
        extractedManualQuestions = importedQuestions;
        extractedManualYear = manualYear;
        lastManualReport = buildManualReport(currentQuestions, importedQuestions, fileName, manualYear);
        renderManualReport(lastManualReport);
        ui.manualUpdateBtn.disabled = !lastManualReport.hasDiscrepancies;
        ui.manualUpdateBtn.textContent = lastManualReport.hasDiscrepancies ? 'Corregir BBDD' : 'Sin discrepancias';
        setManualCheckStatus(
            lastManualReport.hasDiscrepancies ? 'Revisar discrepancias' : 'Sin discrepancias',
            lastManualReport.hasDiscrepancies ? 'offline' : 'online'
        );
    }

    function showImportError(error) {
        console.error('No se pudo comprobar el fichero:', error);
        extractedManualQuestions = [];
        extractedManualYear = '';
        lastManualReport = null;
        setManualCheckStatus('Error', 'offline');
        ui.manualCheckResults.innerHTML = `<p class="error-message">${escapeHtml(error.message)}</p>`;
    }

    async function updateQuestionDatabase() {
        if (!adminUser || extractedManualQuestions.length !== 300 || !lastManualReport) {
            alert('Primero comprueba un PDF o CSV válido con 300 preguntas.');
            return;
        }

        const confirmed = confirm(
            `Hay ${lastManualReport.discrepancyCount} discrepancias. Vas a reemplazar la colección questions con las 300 preguntas revisadas y eliminar registros de respuestas asociados a preguntas que ya no existan. ¿Continuar?`
        );
        if (!confirmed) return;

        ui.manualUpdateBtn.disabled = true;
        ui.manualCheckBtn.disabled = true;
        ui.manualCsvCheckBtn.disabled = true;
        setManualCheckStatus('Actualizando...', 'online');

        try {
            const existingSnapshot = await db.collection('questions').get();
            const newIds = new Set(extractedManualQuestions.map(question => question.id));
            const operations = [];

            existingSnapshot.forEach(doc => {
                if (!newIds.has(doc.id)) operations.push({ type: 'delete', ref: doc.ref });
            });

            extractedManualQuestions.forEach(question => {
                operations.push({
                    type: 'set',
                    ref: db.collection('questions').doc(question.id),
                    data: {
                        ...question,
                        updated_at: firebase.firestore.FieldValue.serverTimestamp(),
                        updated_by: adminUser.email
                    }
                });
            });

            const cleanup = await collectObsoleteAnswerOperations(newIds);
            operations.push(...cleanup.operations);

            await commitOperationsInChunks(operations);
            setManualCheckStatus('BBDD actualizada', 'online');
            ui.manualCheckResults.insertAdjacentHTML(
                'afterbegin',
                `<p class="result-badge result-correct">Base de datos actualizada: ${extractedManualQuestions.length} preguntas activas. Limpieza: ${cleanup.examAnswersDeleted} respuestas y ${cleanup.statsDeleted} estadísticas obsoletas eliminadas.</p>`
            );
        } catch (error) {
            console.error('No se pudo actualizar la BBDD de preguntas:', error);
            setManualCheckStatus('Error', 'offline');
            alert('No se pudo actualizar la BBDD. Revisa permisos o conexión.');
        } finally {
            ui.manualCheckBtn.disabled = false;
            ui.manualCsvCheckBtn.disabled = false;
        }
    }

    async function collectObsoleteAnswerOperations(validQuestionIds) {
        const [answersSnapshot, statsSnapshot] = await Promise.all([
            db.collection('exam_answers').get(),
            db.collection('user_question_stats').get()
        ]);
        const operations = [];
        let examAnswersDeleted = 0;
        let statsDeleted = 0;

        answersSnapshot.forEach(doc => {
            const questionId = String(doc.data().question_id || '');
            if (!validQuestionIds.has(questionId)) {
                operations.push({ type: 'delete', ref: doc.ref });
                examAnswersDeleted += 1;
            }
        });

        statsSnapshot.forEach(doc => {
            const questionId = String(doc.data().question_id || '');
            if (!validQuestionIds.has(questionId)) {
                operations.push({ type: 'delete', ref: doc.ref });
                statsDeleted += 1;
            }
        });

        return { operations, examAnswersDeleted, statsDeleted };
    }

    async function commitOperationsInChunks(operations) {
        const chunkSize = 450;
        for (let index = 0; index < operations.length; index += chunkSize) {
            const batch = db.batch();
            operations.slice(index, index + chunkSize).forEach(operation => {
                if (operation.type === 'delete') batch.delete(operation.ref);
                else batch.set(operation.ref, operation.data);
            });
            await batch.commit();
        }
    }

    function parseCsvQuestions(text) {
        const rows = parseCsv(text);
        if (rows.length < 2) throw new Error('El CSV no contiene filas de preguntas.');

        const headers = rows[0].map(header => normalizeHeader(header));
        const idx = candidates => candidates.map(normalizeHeader).map(name => headers.indexOf(name)).find(index => index >= 0) ?? -1;
        const idIdx = idx(['id', 'codigo', 'code']);
        const taskIdx = idx(['tarea', 'task', 'task_number']);
        const textIdx = idx(['pregunta', 'question', 'question_text']);
        const aIdx = idx(['opcion_a', 'option_a', 'a']);
        const bIdx = idx(['opcion_b', 'option_b', 'b']);
        const cIdx = idx(['opcion_c', 'option_c', 'c']);
        const correctLetterIdx = idx(['respuesta_correcta_letra', 'correct_answer_letter', 'answer_letter']);
        const correctTextIdx = idx(['respuesta_correcta', 'correct_answer', 'answer']);

        if (idIdx < 0 || textIdx < 0 || aIdx < 0 || bIdx < 0 || correctLetterIdx < 0) {
            throw new Error('El CSV debe incluir al menos id, pregunta, opcion_a, opcion_b y respuesta_correcta_letra.');
        }

        const questions = rows.slice(1).filter(row => row.some(Boolean)).map(row => {
            const id = String(row[idIdx] || '').trim();
            const taskNumber = extractTaskNumber(row[taskIdx], id);
            const options = [
                { key: 'a', text: String(row[aIdx] || '').trim() },
                { key: 'b', text: String(row[bIdx] || '').trim() }
            ];
            const optionC = cIdx >= 0 ? String(row[cIdx] || '').trim() : '';
            if (optionC) options.push({ key: 'c', text: optionC });

            let correct = String(row[correctLetterIdx] || '').trim().toLowerCase().replace(/[^a-d]/g, '');
            if (!correct && correctTextIdx >= 0) {
                const correctText = normalizeForSearch(row[correctTextIdx]);
                const match = options.find(option => normalizeForSearch(option.text) === correctText);
                if (match) correct = match.key;
            }

            return {
                id,
                code: id,
                task_number: taskNumber,
                topic: taskTopic(taskNumber),
                question_text: String(row[textIdx] || '').trim(),
                question_type: options.length === 2 ? 'true_false' : 'multiple_choice',
                options,
                correct_answer: correct,
                active: true,
                source: 'CSV CCSE 2026'
            };
        });

        const byId = new Map();
        questions.forEach(question => {
            if (question.id) byId.set(question.id, question);
        });

        return {
            questions: [...byId.values()].sort((left, right) =>
                left.id.localeCompare(right.id, 'es', { numeric: true })
            ),
            manualYear: detectManualYear(text) || '2026',
            answersFound: [...byId.values()].filter(question => question.correct_answer).length,
            missingCodes: expectedQuestionCodes().filter(code => !byId.has(code))
        };
    }

    function parseCsv(text) {
        const rows = [];
        let row = [];
        let cell = '';
        let inQuotes = false;

        for (let index = 0; index < text.length; index += 1) {
            const char = text[index];
            const next = text[index + 1];
            if (char === '"' && inQuotes && next === '"') {
                cell += '"';
                index += 1;
            } else if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                row.push(cell);
                cell = '';
            } else if ((char === '\n' || char === '\r') && !inQuotes) {
                if (char === '\r' && next === '\n') index += 1;
                row.push(cell);
                rows.push(row);
                row = [];
                cell = '';
            } else {
                cell += char;
            }
        }
        row.push(cell);
        if (row.some(value => String(value).trim())) rows.push(row);
        return rows;
    }

    function normalizeHeader(value) {
        return String(value || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    async function extractPdfPages(file) {
        const buffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        const pages = [];

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            pages.push({
                questionText: textItemsToLines(content.items, viewport.width),
                answerText: textItemsToFlowLines(content.items)
            });
        }
        return pages;
    }

    function textItemsToLines(items, pageWidth) {
        const textItems = normalizePdfItems(items);
        if (textItems.length === 0) return '';
        const columnBreak = pageWidth ? pageWidth / 2 : medianColumnBreak(textItems);
        const hasTwoColumns = textItems.filter(item => item.x > columnBreak).length > 12;
        const groups = hasTwoColumns
            ? [textItems.filter(item => item.x <= columnBreak), textItems.filter(item => item.x > columnBreak)]
            : [textItems];
        return groups.map(group => textGroupToLines(group)).filter(Boolean).join('\n');
    }

    function textItemsToFlowLines(items) {
        return textGroupToLines(normalizePdfItems(items));
    }

    function normalizePdfItems(items) {
        return items
            .filter(item => String(item.str || '').trim())
            .map(item => ({
                x: item.transform?.[4] || 0,
                y: item.transform?.[5] || 0,
                text: item.str
            }));
    }

    function medianColumnBreak(items) {
        const xs = [...new Set(items.map(item => Math.round(item.x)))].sort((left, right) => left - right);
        let biggestGap = 0;
        let breakPoint = xs[Math.floor(xs.length / 2)] || 0;
        for (let index = 1; index < xs.length; index += 1) {
            const gap = xs[index] - xs[index - 1];
            if (gap > biggestGap) {
                biggestGap = gap;
                breakPoint = xs[index - 1] + (gap / 2);
            }
        }
        return breakPoint;
    }

    function textGroupToLines(items) {
        const rows = [];
        const tolerance = 2;
        items.forEach(item => {
            let row = rows.find(candidate => Math.abs(candidate.y - item.y) <= tolerance);
            if (!row) {
                row = { y: item.y, items: [] };
                rows.push(row);
            }
            row.items.push(item);
        });
        return rows
            .sort((left, right) => right.y - left.y)
            .map(row => row.items.sort((left, right) => left.x - right.x).map(item => item.text).join(' ').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join('\n');
    }

    function extractQuestionsFromManual(pdfPages) {
        const questionPages = pdfPages.map(page => page.questionText || '');
        const answerPages = pdfPages.map(page => page.answerText || '');
        const pageText = questionPages.join('\n');
        const manualYear = detectManualYear(pageText);
        const answerStart = findAnswerStartPage(answerPages);
        const answers = extractAnswerMap(answerPages.slice(answerStart).join('\n'));
        const questionText = questionPages.slice(0, answerStart).join('\n');
        const byId = new Map();
        [1, 2, 3, 4, 5].forEach(taskNumber => {
            extractTaskQuestions(questionText, taskNumber, answers, manualYear)
                .forEach(question => byId.set(question.id, question));
        });
        return {
            questions: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id, 'es', { numeric: true })),
            manualYear,
            answersFound: answers.size,
            missingCodes: [...answers.keys()].filter(code => !byId.has(code))
        };
    }

    function findAnswerStartPage(pdfPages) {
        let bestIndex = 92;
        let bestCount = 0;
        pdfPages.forEach((_, index) => {
            const count = extractAnswerMap(pdfPages.slice(index, Math.min(index + 10, pdfPages.length)).join('\n')).size;
            if (count >= bestCount) {
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
            const options = selectedLabels.map((label, optionIndex) => ({
                key: label.key,
                text: cleanOptionText(block.slice(label.end, selectedLabels[optionIndex + 1]?.index ?? block.length))
            }));
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
                .filter(match => isValidQuestionCode(match[1]))
                .map(match => [match[1], match[2].toLowerCase()])
        );
    }

    function buildManualReport(currentQuestions, manualQuestions, fileName, manualYear) {
        const currentById = new Map(currentQuestions.map(question => [question.id, question]));
        const manualById = new Map(manualQuestions.map(question => [question.id, question]));
        const questionIssues = [];
        const optionIssues = [];
        const missingCodes = currentQuestions.filter(question => !manualById.has(question.id)).map(question => question.id);
        const addedCodes = manualQuestions.filter(question => !currentById.has(question.id)).map(question => question.id);

        currentQuestions.forEach(question => {
            const manualQuestion = manualById.get(question.id);
            if (!manualQuestion) return;
            if (!sameNormalizedText(question.question_text, manualQuestion.question_text)) {
                questionIssues.push({ id: question.id, text: question.question_text, newText: manualQuestion.question_text });
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

        const discrepancyCount = missingCodes.length + addedCodes.length + questionIssues.length + optionIssues.length;
        return {
            fileName,
            manualYear,
            totalQuestions: currentQuestions.length,
            extractedQuestions: manualQuestions.length,
            missingCodes,
            addedCodes,
            questionIssues,
            optionIssues,
            discrepancyCount,
            hasDiscrepancies: discrepancyCount > 0,
            isOk: discrepancyCount === 0 && currentQuestions.length === 300 && manualQuestions.length === 300
        };
    }

    function renderManualReport(report) {
        const sourceLabel = report.fileName.toLowerCase().endsWith('.csv') ? 'CSV' : 'PDF';
        const status = report.isOk
            ? '<span class="risk-badge risk-ok">Banco alineado</span>'
            : '<span class="risk-badge risk-danger">Hay diferencias que revisar</span>';
        ui.manualCheckResults.innerHTML = `
            <div class="admin-check-grid">
                <div class="admin-card"><span>Origen</span><strong>${escapeHtml(sourceLabel)}</strong></div>
                <div class="admin-card"><span>Archivo</span><strong>${escapeHtml(report.fileName)}</strong></div>
                <div class="admin-card"><span>Banco / archivo</span><strong>${report.totalQuestions}/${report.extractedQuestions}</strong></div>
                <div class="admin-card"><span>Discrepancias</span><strong>${report.discrepancyCount}</strong></div>
                <div class="admin-card"><span>Estado</span><strong>${status}</strong></div>
            </div>
            <p class="admin-notes">${report.hasDiscrepancies
                ? `Se han detectado ${report.discrepancyCount} diferencias. Revísalas antes de corregir la BBDD.`
                : 'No hay discrepancias detectadas.'}</p>
            ${renderIssueBlock('Códigos del banco que no están en el archivo', report.missingCodes)}
            ${renderIssueBlock('Códigos nuevos en el archivo', report.addedCodes)}
            ${renderQuestionIssueBlock('Enunciados distintos', report.questionIssues)}
            ${renderOptionIssueBlock('Opciones o respuestas distintas', report.optionIssues)}
            <p class="admin-notes">El archivo se procesa en este navegador. La BBDD no cambia hasta pulsar Corregir BBDD y confirmar.</p>
        `;
    }

    function renderIssueBlock(title, values) {
        if (values.length === 0) return `<h3>${escapeHtml(title)}</h3><p class="admin-notes">Sin incidencias.</p>`;
        return `
            <h3>${escapeHtml(title)} (${values.length})</h3>
            <ul class="admin-check-list">${values.slice(0, 80).map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>
            ${values.length > 80 ? `<p class="admin-notes">Se muestran 80 de ${values.length} incidencias.</p>` : ''}
        `;
    }

    function renderQuestionIssueBlock(title, issues) {
        if (issues.length === 0) return `<h3>${escapeHtml(title)}</h3><p class="admin-notes">Sin incidencias.</p>`;
        return `
            <h3>${escapeHtml(title)} (${issues.length})</h3>
            <ul class="admin-check-list">
                ${issues.slice(0, 80).map(issue =>
                    `<li><strong>${escapeHtml(issue.id)}</strong>: ${escapeHtml(issue.text)} → ${escapeHtml(issue.newText)}</li>`
                ).join('')}
            </ul>
            ${issues.length > 80 ? `<p class="admin-notes">Se muestran 80 de ${issues.length} incidencias.</p>` : ''}
        `;
    }

    function renderOptionIssueBlock(title, issues) {
        if (issues.length === 0) return `<h3>${escapeHtml(title)}</h3><p class="admin-notes">Sin incidencias.</p>`;
        return `
            <h3>${escapeHtml(title)} (${issues.length})</h3>
            <ul class="admin-check-list">
                ${issues.slice(0, 120).map(issue =>
                    `<li><strong>${escapeHtml(issue.id)} ${escapeHtml(issue.option)}</strong>: ${escapeHtml(issue.text)} → ${escapeHtml(issue.newText)}</li>`
                ).join('')}
            </ul>
            ${issues.length > 120 ? `<p class="admin-notes">Se muestran 120 de ${issues.length} incidencias.</p>` : ''}
        `;
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
        if (!response.ok) throw new Error(`No se pudo cargar preguntas.json (${response.status})`);
        return (await response.json()).filter(question => question.active !== false);
    }

    function validateExtractedQuestions(questions, answersFound = null, missingCodes = [], source = 'archivo') {
        if (questions.length !== 300) {
            const answerNote = answersFound === null ? '' : ` Respuestas detectadas: ${answersFound}.`;
            const missingNote = missingCodes.length === 0
                ? ''
                : ` Códigos pendientes: ${missingCodes.slice(0, 24).join(', ')}${missingCodes.length > 24 ? '...' : ''}.`;
            throw new Error(`El ${source} debe contener 300 preguntas y se han extraído ${questions.length}.${answerNote}${missingNote}`);
        }

        const expected = { 1: 120, 2: 36, 3: 24, 4: 36, 5: 84 };
        Object.entries(expected).forEach(([task, amount]) => {
            const found = questions.filter(question => question.task_number === Number(task)).length;
            if (found !== amount) throw new Error(`La tarea ${task} debe tener ${amount} preguntas y se han extraído ${found}.`);
        });

        questions.forEach(question => {
            if (!question.id || !question.question_text) throw new Error(`La pregunta ${question.id || 'sin código'} no está completa.`);
            if (!question.options.some(option => option.key === question.correct_answer)) {
                throw new Error(`La pregunta ${question.id} tiene una respuesta correcta no disponible.`);
            }
        });
    }

    function expectedQuestionCodes() {
        const ranges = [[1001, 1120], [2001, 2036], [3001, 3024], [4001, 4036], [5001, 5084]];
        return ranges.flatMap(([start, end]) => {
            const values = [];
            for (let code = start; code <= end; code += 1) values.push(String(code));
            return values;
        });
    }

    function isValidQuestionCode(code) {
        return expectedQuestionCodes().includes(String(code));
    }

    function extractTaskNumber(value, id) {
        const fromValue = String(value || '').match(/[1-5]/);
        if (fromValue) return Number(fromValue[0]);
        return Number(String(id || '').charAt(0)) || 1;
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
        return cleanPdfText(value).replace(/^\d{1,3}\s+/, '').trim();
    }

    function cleanOptionText(value) {
        return cleanPdfText(value).replace(/\b[1-5]\d{3}\b[\s\S]*$/, '').trim();
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
        if (String(user.email || '').toLowerCase() === ADMIN_EMAIL) return '<span class="admin-notes">Admin</span>';
        if (user.blocked === true) {
            return `<button class="btn btn-primary btn-compact" data-action="unblock" data-user-id="${escapeHtml(user.id)}" type="button">Desbloquear</button>`;
        }
        return `<button class="btn btn-danger btn-compact" data-action="block" data-user-id="${escapeHtml(user.id)}" type="button">Bloquear</button>`;
    }

    function sameNormalizedText(left, right) {
        return normalizeForSearch(left) === normalizeForSearch(right);
    }

    function detectManualYear(text) {
        const matches = [...String(text || '').matchAll(/\b20\d{2}\b/g)].map(match => match[0]);
        const counts = matches.reduce((accumulator, year) => {
            accumulator[year] = (accumulator[year] || 0) + 1;
            return accumulator;
        }, {});
        return Object.entries(counts).sort((left, right) => right[1] - left[1]).map(([year]) => year)[0] || '';
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
        return new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(millis));
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
