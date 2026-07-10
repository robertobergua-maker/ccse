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
        activityBody: document.getElementById('activity-body')
    };

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
