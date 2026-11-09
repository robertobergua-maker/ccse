document.addEventListener('DOMContentLoaded', function() {
    const ADMIN_EMAIL = 'roberto.bergua@gmail.com';
    const TERMS_VERSION = '2026-09';
    const MIN_PASSWORD_LENGTH = 8;

    const PUBLIC_PAGES = ['login.html', 'index.html'];
    const GUEST_PAGES  = ['dashboard.html', 'examen.html', 'results.html', 'preguntas.html'];

    const auth = firebase.auth();
    const db   = firebase.firestore();
    const $    = id => document.getElementById(id);

    const ui = {
        // Comunes a todas las páginas
        logoutBtn:        $('logout-btn'),
        userInfo:         $('user-info'),
        // Entrar
        loginGoogleBtn:   $('login-google-btn'),
        loginEmail:       $('login-email'),
        loginPassword:    $('login-password'),
        loginBtn:         $('login-btn'),
        loginError:       $('login-error'),
        forgotPwBtn:      $('forgot-pw-btn'),
        // Crear cuenta con código
        inviteCodeInput:  $('invite-code-input'),
        validateCodeBtn:  $('validate-code-btn'),
        inviteFeedback:   $('invite-feedback'),
        registerStep2:    $('register-step2'),
        registerTerms:    $('register-terms'),
        registerGoogleBtn: $('register-google-btn'),
        registerEmail:    $('register-email'),
        registerPassword: $('register-password'),
        registerBtn:      $('register-btn'),
        registerError:    $('register-error'),
        // Solicitud de acceso
        requestFormWrap:  $('request-form-wrap'),
        requestName:      $('request-name'),
        requestEmail:     $('request-email'),
        requestMessage:   $('request-message'),
        requestWebsite:   $('request-website'),
        requestTerms:     $('request-terms'),
        requestBtn:       $('request-btn'),
        requestError:     $('request-error'),
        requestDone:      $('request-done')
    };

    const googleProvider = new firebase.auth.GoogleAuthProvider();
    const PENDING_INVITE_KEY = 'ccse_pending_invite_code';

    let currentMode = 'login';
    let validatedInviteCode = null;

    // ── SELECTOR DE MODO (Entrar / Crear cuenta / Pedir acceso) ──────────────

    const MODES = ['login', 'register', 'request'];
    const modeErrorEl = {
        login: ui.loginError, register: ui.registerError, request: ui.requestError
    };

    function setMode(mode, { focus = true } = {}) {
        if (!MODES.includes(mode)) mode = 'login';
        currentMode = mode;
        MODES.forEach(m => {
            const panel = $(`mode-${m}`);
            const btn = $(`mode-btn-${m}`);
            if (panel) panel.hidden = m !== mode;
            if (btn) {
                btn.classList.toggle('active', m === mode);
                btn.setAttribute('aria-selected', String(m === mode));
            }
        });
        MODES.forEach(m => clearError(modeErrorEl[m]));
        if (!focus) return;
        const first = { login: ui.loginEmail, register: ui.inviteCodeInput, request: ui.requestName }[mode];
        first?.focus();
    }

    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });
    document.querySelectorAll('[data-goto-mode]').forEach(btn => {
        btn.addEventListener('click', () => setMode(btn.dataset.gotoMode));
    });

    if ($('mode-login')) {
        const fromHash = window.location.hash.replace('#', '');
        setMode(MODES.includes(fromHash) ? fromHash : 'login', { focus: false });
    }

    // ── MOSTRAR / OCULTAR CONTRASEÑA ─────────────────────────────────────────

    document.querySelectorAll('.toggle-pw').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = $(btn.dataset.target);
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
            btn.textContent = input.type === 'password' ? '👁' : '🙈';
        });
    });

    // ── ENTRAR ───────────────────────────────────────────────────────────────

    ui.loginBtn?.addEventListener('click', async () => {
        const email    = ui.loginEmail?.value.trim();
        const password = ui.loginPassword?.value;
        if (!email || !password) return showError(ui.loginError, 'Introduce tu correo y tu contraseña.');

        setLoginLoading(true);
        clearError(ui.loginError);
        try {
            await auth.signInWithEmailAndPassword(email, password);
            // onAuthStateChanged se encarga del resto
        } catch (err) {
            showError(ui.loginError, friendlyAuthError(err));
            setLoginLoading(false);
        }
    });

    [ui.loginEmail, ui.loginPassword].forEach(input => {
        input?.addEventListener('keydown', e => {
            if (e.key === 'Enter') ui.loginBtn?.click();
        });
    });

    ui.forgotPwBtn?.addEventListener('click', async () => {
        const email = ui.loginEmail?.value.trim();
        if (!email) return showError(ui.loginError, 'Escribe tu correo arriba y vuelve a pulsar «¿Olvidaste la contraseña?».');
        clearError(ui.loginError);
        try {
            await auth.sendPasswordResetEmail(email);
            showError(ui.loginError, '📧 Si existe una cuenta con ese correo, recibirás un mensaje para restablecer la contraseña.', true);
        } catch (err) {
            showError(ui.loginError, friendlyAuthError(err));
        }
    });

    ui.loginGoogleBtn?.addEventListener('click', () => {
        clearError(ui.loginError);
        signInWithGoogle(ui.loginError);
    });

    // ── CREAR CUENTA CON CÓDIGO ──────────────────────────────────────────────

    if (ui.inviteCodeInput && ui.validateCodeBtn) {
        ui.inviteCodeInput.addEventListener('input', () => {
            ui.validateCodeBtn.disabled = ui.inviteCodeInput.value.trim().length === 0;
            if (validatedInviteCode) resetValidatedCode();
        });

        ui.inviteCodeInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') ui.validateCodeBtn.click();
        });

        ui.validateCodeBtn.addEventListener('click', async () => {
            const raw = normalizeInviteCode(ui.inviteCodeInput.value);
            if (!raw) return;

            ui.validateCodeBtn.disabled = true;
            ui.validateCodeBtn.textContent = 'Comprobando…';
            setFeedback('', '');
            ui.inviteCodeInput.classList.remove('valid', 'invalid');

            try {
                const result = await validateInviteCode(raw);
                if (result.ok) {
                    validatedInviteCode = raw;
                    rememberPendingInviteCode(raw);
                    ui.inviteCodeInput.classList.add('valid');
                    setFeedback('✓ Código válido.', 'ok');
                    if (ui.registerStep2) ui.registerStep2.hidden = false;
                    ui.registerEmail?.focus();
                } else {
                    ui.inviteCodeInput.classList.add('invalid');
                    setFeedback(result.reason, 'error');
                }
            } catch (err) {
                setFeedback('No se pudo comprobar el código. Revisa la conexión.', 'error');
            }

            ui.validateCodeBtn.disabled = false;
            ui.validateCodeBtn.textContent = 'Comprobar';
        });
    }

    function resetValidatedCode() {
        validatedInviteCode = null;
        forgetPendingInviteCode();
        ui.inviteCodeInput?.classList.remove('valid', 'invalid');
        setFeedback('', '');
        if (ui.registerStep2) ui.registerStep2.hidden = true;
    }

    ui.registerBtn?.addEventListener('click', async event => {
        event.preventDefault();
        clearError(ui.registerError);

        if (!validatedInviteCode) {
            return showError(ui.registerError, 'Primero comprueba tu código de invitación.');
        }
        if (!ui.registerTerms?.checked) {
            return showError(ui.registerError, 'Debes aceptar los Términos y Condiciones y la Política de Privacidad.');
        }
        const email    = ui.registerEmail?.value.trim();
        const password = ui.registerPassword?.value;
        if (!email || !password) return showError(ui.registerError, 'Introduce correo y contraseña.');
        if (password.length < MIN_PASSWORD_LENGTH) {
            return showError(ui.registerError, `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
        }

        setRegisterLoading(true);
        try {
            rememberPendingInviteCode(validatedInviteCode);
            await auth.createUserWithEmailAndPassword(email, password);
            // onAuthStateChanged completa el alta en Firestore.
        } catch (err) {
            console.error('Error durante la creación de la cuenta:', err);
            showError(ui.registerError, friendlyAuthError(err));
            setRegisterLoading(false);
        }
    });

    [ui.registerEmail, ui.registerPassword].forEach(input => {
        input?.addEventListener('keydown', e => {
            if (e.key === 'Enter') ui.registerBtn?.click();
        });
    });

    ui.registerGoogleBtn?.addEventListener('click', () => {
        clearError(ui.registerError);
        if (!validatedInviteCode) {
            return showError(ui.registerError, 'Primero comprueba tu código de invitación.');
        }
        if (!ui.registerTerms?.checked) {
            return showError(ui.registerError, 'Debes aceptar los Términos y Condiciones y la Política de Privacidad.');
        }
        rememberPendingInviteCode(validatedInviteCode);
        signInWithGoogle(ui.registerError);
    });

    // ── SOLICITUD DE ACCESO ──────────────────────────────────────────────────

    ui.requestBtn?.addEventListener('click', async () => {
        clearError(ui.requestError);

        const name    = (ui.requestName?.value || '').trim().replace(/\s+/g, ' ');
        const email   = (ui.requestEmail?.value || '').trim().toLowerCase();
        const message = (ui.requestMessage?.value || '').trim();

        if (name.length < 2) return showError(ui.requestError, 'Escribe tu nombre.');
        if (!isValidEmail(email)) return showError(ui.requestError, 'Escribe un correo electrónico válido.');
        if (!ui.requestTerms?.checked) {
            return showError(ui.requestError, 'Debes aceptar los Términos y Condiciones y la Política de Privacidad.');
        }

        ui.requestBtn.disabled = true;
        ui.requestBtn.textContent = 'Enviando…';

        try {
            // Campo trampa para bots: si está relleno, se simula el éxito sin enviar nada.
            if (!ui.requestWebsite?.value) {
                await db.collection('registration_requests').doc(email).set({
                    name,
                    email,
                    message,
                    status: 'pending',
                    created_at: firebase.firestore.FieldValue.serverTimestamp(),
                    terms_accepted: true,
                    terms_version: TERMS_VERSION
                });
            }
            if (ui.requestFormWrap) ui.requestFormWrap.hidden = true;
            if (ui.requestDone) ui.requestDone.hidden = false;
        } catch (err) {
            console.error('No se pudo enviar la solicitud:', err);
            if (err?.code === 'permission-denied') {
                showError(ui.requestError,
                    'No se pudo enviar. Si ya habías solicitado acceso con este correo, espera la respuesta del administrador.');
            } else {
                showError(ui.requestError, 'No se pudo enviar la solicitud. Revisa la conexión e inténtalo de nuevo.');
            }
            ui.requestBtn.disabled = false;
            ui.requestBtn.textContent = 'Enviar solicitud';
        }
    });

    // ── LOGIN CON GOOGLE ─────────────────────────────────────────────────────

    function signInWithGoogle(errorEl) {
        auth.signInWithPopup(googleProvider).catch(error => {
            console.error('Error durante el inicio de sesión con Google:', error);
            showError(errorEl, friendlyAuthError(error, 'google'));
        });
    }

    ui.logoutBtn?.addEventListener('click', () => {
        auth.signOut().then(() => {
            window.location.href = 'index.html';
        }).catch(console.error);
    });

    // ── OBSERVADOR DE AUTENTICACIÓN ──────────────────────────────────────────

    let authResolved = false;

    auth.onAuthStateChanged(user => {
        const currentPage = window.location.pathname.split('/').pop() || 'index.html';

        if (user) {
            authResolved = true;
            const registration = handleNewUserRegistration(user);

            registration.then(async ({ denied, reason, newUser, profile: newProfile }) => {
                if (denied) {
                    if (newUser && isRecentAuthUser(user)) {
                        const deleted = await deleteDeniedAuthUser(user);
                        if (!deleted) {
                            showError(activeErrorEl(),
                                'No se pudo eliminar la cuenta rechazada. Contacta con el administrador.');
                        }
                    }
                    try {
                        await auth.signOut();
                    } catch (error) {
                        console.error('No se pudo cerrar la sesión rechazada:', error);
                    }
                    setLoginLoading(false);
                    setRegisterLoading(false);

                    if (reason === 'bad_code') {
                        ui.inviteCodeInput?.classList.remove('valid');
                        ui.inviteCodeInput?.classList.add('invalid');
                        resetValidatedCode();
                        setFeedback('El código ya fue usado o no es válido. Solicita uno nuevo.', 'error');
                    } else if (reason === 'no_terms') {
                        showError(activeErrorEl(), 'Debes aceptar los Términos y Condiciones para crear la cuenta.');
                    } else {
                        showError(activeErrorEl(),
                            'No existe una cuenta con ese correo. Si es tu primera vez, usa tu código en «Crear cuenta» o solicita acceso en «Pedir acceso».');
                    }
                    return;
                }

                const profile = newProfile || await saveUserToFirestore(user);

                if (!profile) {
                    throw new Error('No se pudo obtener el perfil del usuario.');
                }

                if (isBlockedProfile(profile) && !isAdmin(user)) {
                    if (!currentPage.endsWith('blocked.html')) {
                        window.location.href = 'blocked.html';
                    }
                    return;
                }

                if (currentPage.endsWith('blocked.html')) {
                    window.location.href = 'dashboard.html';
                }

                if (ui.userInfo) {
                    ui.userInfo.textContent = `Hola, ${user.displayName || user.email}`;
                }

                // Limpiar rastro de modo invitado
                const guestBanner = $('guest-banner');
                if (guestBanner) guestBanner.hidden = true;
                const loginLink = $('login-link');
                if (loginLink) loginLink.hidden = true;
                if (ui.logoutBtn) ui.logoutBtn.hidden = false;

                if (PUBLIC_PAGES.some(p => currentPage.endsWith(p))) {
                    window.location.href = 'dashboard.html';
                }

                window._authReady   = true;
                window._currentUser = user;
                window._isGuest     = false;
                document.dispatchEvent(new CustomEvent('authReady', { detail: { user, isGuest: false } }));
            }).catch(error => {
                console.error('Error durante la resolución de autenticación:', error);
                setLoginLoading(false);
                setRegisterLoading(false);
                showError(activeErrorEl(), 'No se pudo completar el acceso. Inténtalo de nuevo.');
            });

        } else {
            // Firebase llama con null primero mientras carga la sesión de IndexedDB.
            // Solo despachamos invitado si no llega un usuario real en el siguiente ciclo.
            if (authResolved) {
                // Ya resolvimos antes con un usuario, esto es un signOut real
                dispatchGuestReady(currentPage);
                return;
            }

            const capturedPage = currentPage;
            const check = () => {
                if (authResolved) return; // llegó usuario real, no hacer nada
                authResolved = true;
                dispatchGuestReady(capturedPage);
            };

            requestAnimationFrame(() => requestAnimationFrame(check));
        }
    });

    function dispatchGuestReady(currentPage) {
        window._authReady   = true;
        window._currentUser = null;
        window._isGuest     = true;

        if (PUBLIC_PAGES.some(p => currentPage.endsWith(p)) || GUEST_PAGES.some(p => currentPage.endsWith(p))) {
            document.dispatchEvent(new CustomEvent('authReady', { detail: { user: null, isGuest: true } }));
            return;
        }
        window.location.href = 'login.html';
    }

    // ── CONTROL DE REGISTRO NUEVO ────────────────────────────────────────────

    async function handleNewUserRegistration(user) {
        if (isAdmin(user)) return { denied: false, newUser: false, profile: null };

        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            if (userDoc.exists) return { denied: false, newUser: false, profile: null }; // ya registrado

            const inviteCode = validatedInviteCode || recallPendingInviteCode();
            if (currentMode !== 'register' || !inviteCode) {
                return { denied: true, reason: 'no_account', newUser: true, profile: null };
            }
            if (!ui.registerTerms?.checked) {
                return { denied: true, reason: 'no_terms', newUser: true, profile: null };
            }

            const profile = buildNewUserProfile(user, inviteCode);
            const created = await claimInviteAndCreateUser(inviteCode, user, profile);
            if (created) forgetPendingInviteCode();
            return {
                denied: !created,
                reason: created ? null : 'bad_code',
                newUser: true,
                profile: created ? { ...profile, blocked: false } : null
            };
        } catch (err) {
            console.error('Error al comprobar registro nuevo:', err);
            return { denied: true, reason: 'bad_code', newUser: true, profile: null };
        }
    }

    async function deleteDeniedAuthUser(user) {
        try {
            await user.delete();
            return true;
        } catch (err) {
            console.error('No se pudo eliminar el usuario rechazado de Firebase Auth:', err);
            return false;
        }
    }

    // ── VALIDACIÓN Y CONSUMO DE CÓDIGO ───────────────────────────────────────

    async function validateInviteCode(code) {
        try {
            const doc = await db.collection('invite_codes').doc(code).get();
            if (!doc.exists || doc.data()?.used !== false) {
                return { ok: false, reason: 'Código no disponible. Comprueba que lo has escrito correctamente.' };
            }
            return { ok: true };
        } catch (err) {
            if (err?.code === 'permission-denied') {
                return { ok: false, reason: 'Código no disponible. Comprueba que lo has escrito correctamente.' };
            }
            throw err;
        }
    }

    async function claimInviteAndCreateUser(code, user, profile) {
        try {
            const codeRef = db.collection('invite_codes').doc(code);
            const userRef = db.collection('users').doc(user.uid);
            const doc = await codeRef.get();
            if (!doc.exists) return false;

            const codeData = doc.data();
            if (codeData?.used === true) {
                const belongsToUser = codeData.used_by_uid === user.uid
                    && codeData.used_by_email === user.email;
                if (!belongsToUser) return false;

                await userRef.set(profile);
                return true;
            }

            if (codeData?.used !== false) return false;

            const batch = db.batch();
            batch.update(codeRef, {
                used:           true,
                used_by_uid:    user.uid,
                used_by_email:  user.email,
                used_at:        firebase.firestore.FieldValue.serverTimestamp()
            });
            batch.set(userRef, profile);
            await batch.commit();
            return true;
        } catch (err) {
            console.error('Error al reclamar el código y crear el perfil:', err);
            return false;
        }
    }

    // ── GUARDAR USUARIO EN FIRESTORE ─────────────────────────────────────────

    function saveUserToFirestore(user) {
        const ref = db.collection('users').doc(user.uid);
        return ref.get().then(doc => {
            if (!doc.exists) {
                return ref.set(buildNewUserProfile(user, validatedInviteCode))
                    .then(() => ({ id: user.uid, blocked: false }));
            }
            const profile = doc.data();
            return ref.update({ last_login: firebase.firestore.FieldValue.serverTimestamp() })
                .then(() => profile)
                .catch(() => profile);
        }).catch(err => {
            console.error('Error al guardar usuario:', err);
            return null;
        });
    }

    function buildNewUserProfile(user, inviteCode) {
        return {
            id:                user.uid,
            name:              user.displayName || user.email,
            email:             user.email,
            invite_code:       inviteCode || null,
            created_at:        firebase.firestore.FieldValue.serverTimestamp(),
            last_login:        firebase.firestore.FieldValue.serverTimestamp(),
            terms_accepted_at: firebase.firestore.FieldValue.serverTimestamp(),
            terms_version:     TERMS_VERSION
        };
    }

    // ── HELPERS ──────────────────────────────────────────────────────────────

    function isAdmin(user) {
        return String(user.email || '').toLowerCase() === ADMIN_EMAIL;
    }

    function isBlockedProfile(profile) {
        return profile && profile.blocked === true;
    }

    function isValidEmail(value) {
        return value.length <= 120 && /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(value);
    }

    function setLoginLoading(loading) {
        if (!ui.loginBtn) return;
        ui.loginBtn.disabled = loading;
        ui.loginBtn.textContent = loading ? 'Entrando…' : 'Entrar';
    }

    function setRegisterLoading(loading) {
        if (!ui.registerBtn) return;
        ui.registerBtn.disabled = loading;
        ui.registerBtn.textContent = loading ? 'Creando cuenta…' : 'Crear cuenta';
    }

    function activeErrorEl() {
        return modeErrorEl[currentMode] || ui.loginError;
    }

    function showError(el, msg, isInfo = false) {
        if (!el) return;
        el.textContent = msg;
        el.classList.add('visible');
        el.classList.toggle('info', isInfo);
    }

    function clearError(el) {
        if (!el) return;
        el.textContent = '';
        el.classList.remove('visible', 'info');
    }

    function setFeedback(msg, type) {
        if (!ui.inviteFeedback) return;
        ui.inviteFeedback.textContent = msg;
        ui.inviteFeedback.className = `invite-feedback ${type}`;
    }

    function normalizeInviteCode(value) {
        return String(value || '')
            .trim()
            .toUpperCase()
            .replace(/[^A-Z0-9-]/g, '');
    }

    function rememberPendingInviteCode(code) {
        try {
            window.sessionStorage.setItem(PENDING_INVITE_KEY, code);
        } catch (err) {
            console.warn('No se pudo guardar el código pendiente:', err);
        }
    }

    function recallPendingInviteCode() {
        try {
            return window.sessionStorage.getItem(PENDING_INVITE_KEY);
        } catch (err) {
            return null;
        }
    }

    function forgetPendingInviteCode() {
        try {
            window.sessionStorage.removeItem(PENDING_INVITE_KEY);
        } catch (err) {
            console.warn('No se pudo limpiar el código pendiente:', err);
        }
    }

    function isRecentAuthUser(user) {
        const createdAt = Date.parse(user.metadata?.creationTime || '');
        if (Number.isNaN(createdAt)) return false;
        return Date.now() - createdAt < 5 * 60 * 1000;
    }

    /** Convierte códigos de error de Firebase Auth en mensajes legibles */
    function friendlyAuthError(err, provider = 'email') {
        const map = {
            'auth/invalid-email':            'El correo no tiene un formato válido.',
            'auth/user-not-found':           'No existe una cuenta con ese correo.',
            'auth/wrong-password':           'Contraseña incorrecta.',
            'auth/invalid-credential':       'Correo o contraseña incorrectos.',
            'auth/email-already-in-use':     'Ya existe una cuenta con ese correo. Prueba a entrar en la pestaña «Entrar».',
            'auth/weak-password':            `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
            'auth/too-many-requests':        'Demasiados intentos fallidos. Espera unos minutos.',
            'auth/network-request-failed':   'Sin conexión. Revisa tu red.',
            'auth/popup-closed-by-user':     'Se cerró la ventana de acceso.',
            'auth/cancelled-popup-request':  'Se canceló la solicitud de acceso.',
            'auth/popup-blocked':            'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes e inténtalo de nuevo.',
            'auth/unauthorized-domain':      'Este dominio no está autorizado en Firebase Auth. Añade el dominio actual en Authentication > Settings > Authorized domains.',
            'auth/operation-not-allowed':    provider === 'google'
                ? 'Google no está activado en Firebase Auth. Actívalo en Authentication > Sign-in method > Google.'
                : 'Correo y contraseña no está activado en Firebase Auth. Actívalo en Authentication > Sign-in method > Email/Password.'
        };
        return map[err.code] || `Error: ${err.message}`;
    }
});
