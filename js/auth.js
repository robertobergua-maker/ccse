document.addEventListener('DOMContentLoaded', function() {
    const ADMIN_EMAIL = 'roberto.bergua@gmail.com';

    const PUBLIC_PAGES = ['login.html', 'index.html'];
    const GUEST_PAGES  = ['dashboard.html', 'examen.html', 'results.html', 'preguntas.html'];

    const auth = firebase.auth();
    const db   = firebase.firestore();

    const ui = {
        // Comunes a todas las páginas
        logoutBtn:        document.getElementById('logout-btn'),
        userInfo:         document.getElementById('user-info'),
        // Login con Google
        googleLoginBtn:   document.getElementById('google-login-btn'),
        // Login con email/password
        emailInput:       document.getElementById('email-input'),
        passwordInput:    document.getElementById('password-input'),
        emailLoginBtn:    document.getElementById('email-login-btn'),
        emailRegisterBtn: document.getElementById('email-register-btn'),
        emailFormError:   document.getElementById('email-form-error'),
        forgotPwBtn:      document.getElementById('forgot-pw-btn'),
        // Código de invitación
        inviteCodeInput:  document.getElementById('invite-code-input'),
        validateCodeBtn:  document.getElementById('validate-code-btn'),
        inviteFeedback:   document.getElementById('invite-feedback'),
        skipCodeBtn:      document.getElementById('skip-code-btn')
    };

    const googleProvider = new firebase.auth.GoogleAuthProvider();

    const PENDING_INVITE_KEY = 'ccse_pending_invite_code';

    let validatedInviteCode = null;
    let skipInvite = false;

    // ── TABS ─────────────────────────────────────────────────────────────────

    document.querySelectorAll('.auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.auth-tab').forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
            });
            document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
            document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add('active');
        });
    });

    // ── TOGGLE CONTRASEÑA ────────────────────────────────────────────────────

    document.querySelectorAll('.toggle-pw').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById(btn.dataset.target);
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
            btn.textContent = input.type === 'password' ? '👁' : '🙈';
        });
    });

    // ── CÓDIGO DE INVITACIÓN ─────────────────────────────────────────────────

    if (ui.inviteCodeInput && ui.validateCodeBtn) {
        ui.inviteCodeInput.addEventListener('input', () => {
            const code = ui.inviteCodeInput.value.trim();
            ui.validateCodeBtn.disabled = code.length === 0;
            if (validatedInviteCode) {
                validatedInviteCode = null;
                skipInvite = false;
                ui.inviteCodeInput.classList.remove('valid', 'invalid');
                setFeedback('', '');
                lockAuthButtons(true);
            }
        });

        ui.inviteCodeInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') ui.validateCodeBtn.click();
        });

        ui.validateCodeBtn.addEventListener('click', async () => {
            const raw = normalizeInviteCode(ui.inviteCodeInput.value);
            if (!raw) return;

            ui.validateCodeBtn.disabled = true;
            ui.validateCodeBtn.textContent = 'Verificando…';
            setFeedback('', '');
            ui.inviteCodeInput.classList.remove('valid', 'invalid');

            try {
                const result = await validateInviteCode(raw);
                if (result.ok) {
                    validatedInviteCode = raw;
                    rememberPendingInviteCode(raw);
                    ui.inviteCodeInput.classList.add('valid');
                    setFeedback('✓ Código válido. Ahora elige cómo acceder.', 'ok');
                    lockAuthButtons(false);
                } else {
                    ui.inviteCodeInput.classList.add('invalid');
                    setFeedback(result.reason, 'error');
                    lockAuthButtons(true);
                }
            } catch (err) {
                setFeedback('No se pudo verificar el código. Revisa la conexión.', 'error');
            }

            ui.validateCodeBtn.disabled = false;
            ui.validateCodeBtn.textContent = 'Validar';
        });
    }

    if (ui.skipCodeBtn) {
        ui.skipCodeBtn.addEventListener('click', () => {
            skipInvite = true;
            validatedInviteCode = null;
            forgetPendingInviteCode();
            unlockExistingUserLogin();
            setFeedback('Puedes iniciar sesión directamente si ya tienes cuenta.', 'ok');
            if (ui.inviteCodeInput) {
                ui.inviteCodeInput.disabled = true;
                ui.inviteCodeInput.classList.remove('valid', 'invalid');
            }
            if (ui.validateCodeBtn) ui.validateCodeBtn.disabled = true;
        });
    }

    // ── LOGIN / REGISTRO CON EMAIL ────────────────────────────────────────────

    if (ui.emailLoginBtn) {
        ui.emailLoginBtn.addEventListener('click', async () => {
            const email    = ui.emailInput?.value.trim();
            const password = ui.passwordInput?.value;
            if (!email || !password) return showEmailError('Introduce correo y contraseña.');

            setEmailButtonsLoading(true);
            clearEmailError();
            try {
                await auth.signInWithEmailAndPassword(email, password);
                // onAuthStateChanged se encarga del resto
            } catch (err) {
                showEmailError(friendlyAuthError(err));
                setEmailButtonsLoading(false);
            }
        });
    }

    if (ui.emailRegisterBtn) {
        ui.emailRegisterBtn.addEventListener('click', async () => {
            const email    = ui.emailInput?.value.trim();
            const password = ui.passwordInput?.value;
            if (!validatedInviteCode) {
                return showEmailError('Para registrarte necesitas validar primero un código de invitación.');
            }
            if (!email || !password) return showEmailError('Introduce correo y contraseña.');
            if (password.length < 6) return showEmailError('La contraseña debe tener al menos 6 caracteres.');

            setEmailButtonsLoading(true);
            clearEmailError();
            try {
                await auth.createUserWithEmailAndPassword(email, password);
                // onAuthStateChanged se encarga del resto
            } catch (err) {
                showEmailError(friendlyAuthError(err));
                setEmailButtonsLoading(false);
            }
        });
    }

    // Enviar con Enter en los campos de email/password
    [ui.emailInput, ui.passwordInput].forEach(input => {
        input?.addEventListener('keydown', e => {
            if (e.key === 'Enter') ui.emailLoginBtn?.click();
        });
    });

    if (ui.forgotPwBtn) {
        ui.forgotPwBtn.addEventListener('click', async () => {
            const email = ui.emailInput?.value.trim();
            if (!email) return showEmailError('Introduce tu correo para recuperar la contraseña.');
            clearEmailError();
            try {
                await auth.sendPasswordResetEmail(email);
                showEmailError('📧 Correo de recuperación enviado. Revisa tu bandeja de entrada.', true);
            } catch (err) {
                showEmailError(friendlyAuthError(err));
            }
        });
    }

    // ── LOGIN CON GOOGLE ─────────────────────────────────────────────────────

    if (ui.googleLoginBtn) {
        ui.googleLoginBtn.addEventListener('click', () => {
            auth.signInWithPopup(googleProvider)
                .catch(error => {
                    console.error('Error durante el inicio de sesión con Google:', error);
                    alert('No se pudo iniciar sesión con Google. Revisa tu conexión.');
                });
        });
    }

    if (ui.logoutBtn) {
        ui.logoutBtn.addEventListener('click', () => {
            auth.signOut().then(() => {
                window.location.href = 'index.html';
            }).catch(console.error);
        });
    }

    // ── OBSERVADOR DE AUTENTICACIÓN ──────────────────────────────────────────

    let authResolved = false;

    auth.onAuthStateChanged(user => {
        const currentPage = window.location.pathname.split('/').pop() || 'index.html';

        if (user) {
            authResolved = true;
            const registration = handleNewUserRegistration(user);

            registration.then(async ({ denied, newUser, profile: newProfile }) => {
                if (denied) {
                    if (newUser && isRecentAuthUser(user)) {
                        await deleteDeniedAuthUser(user);
                    }
                    await auth.signOut().catch(console.error);
                    setFeedback('El código ya fue usado o no es válido. Solicita uno nuevo.', 'error');
                    lockAuthButtons(true);
                    if (ui.inviteCodeInput) {
                        ui.inviteCodeInput.disabled = false;
                        ui.inviteCodeInput.classList.remove('valid');
                        ui.inviteCodeInput.classList.add('invalid');
                    }
                    setEmailButtonsLoading(false);
                    return;
                }

                const profilePromise = newProfile
                    ? Promise.resolve(newProfile)
                    : saveUserToFirestore(user);

                profilePromise.then(profile => {
                    if (isBlockedProfile(profile) && !isAdmin(user)) {
                        if (!currentPage.endsWith('blocked.html')) {
                            window.location.href = 'blocked.html';
                        }
                        return;
                    }
                    if (currentPage.endsWith('blocked.html')) {
                        window.location.href = 'dashboard.html';
                    }
                });

                if (ui.userInfo) {
                    ui.userInfo.textContent = `Hola, ${user.displayName || user.email}`;
                }

                // Limpiar rastro de modo invitado
                const guestBanner = document.getElementById('guest-banner');
                if (guestBanner) guestBanner.hidden = true;
                const loginLink = document.getElementById('login-link');
                if (loginLink) loginLink.hidden = true;
                const logoutBtn = document.getElementById('logout-btn');
                if (logoutBtn) logoutBtn.hidden = false;

                if (PUBLIC_PAGES.some(p => currentPage.endsWith(p))) {
                    window.location.href = 'dashboard.html';
                }

                window._authReady   = true;
                window._currentUser = user;
                window._isGuest     = false;
                document.dispatchEvent(new CustomEvent('authReady', { detail: { user, isGuest: false } }));
            });

        } else {
            // Firebase llama con null primero mientras carga la sesión de IndexedDB.
            // Solo despachamos invitado si no llega un usuario real en el siguiente tick
            // de microtareas (que es cuando Firebase resuelve la sesión en caché).
            if (authResolved) {
                // Ya resolvimos antes con un usuario, esto es un signOut real
                dispatchGuestReady(currentPage);
                return;
            }

            // Primera llamada con null: esperar al siguiente ciclo de eventos completo
            // Firebase resuelve la sesión en caché en la misma cola de microtareas,
            // pero el callback de onAuthStateChanged llega como macrotarea.
            // Usamos requestAnimationFrame (después de render) para dar tiempo suficiente.
            const capturedPage = currentPage;
            const check = () => {
                if (authResolved) return; // llegó usuario real, no hacer nada
                authResolved = true;
                dispatchGuestReady(capturedPage);
            };

            // Doble seguridad: rAF + setTimeout 0 encadenados
            requestAnimationFrame(() => requestAnimationFrame(check));
        }
    });

    function dispatchGuestReady(currentPage) {
        window._authReady   = true;
        window._currentUser = null;
        window._isGuest     = true;

        if (PUBLIC_PAGES.some(p => currentPage.endsWith(p))) {
            document.dispatchEvent(new CustomEvent('authReady', { detail: { user: null, isGuest: true } }));
            return;
        }
        if (GUEST_PAGES.some(p => currentPage.endsWith(p))) {
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

            if (skipInvite) return { denied: true, newUser: true, profile: null };
            const inviteCode = validatedInviteCode || recallPendingInviteCode();
            if (!inviteCode) return { denied: true, newUser: true, profile: null };

            const profile = buildNewUserProfile(user, inviteCode);
            const created = await claimInviteAndCreateUser(inviteCode, user, profile);
            if (created) forgetPendingInviteCode();
            return {
                denied: !created,
                newUser: true,
                profile: created ? { ...profile, blocked: false } : null
            };
        } catch (err) {
            console.error('Error al comprobar registro nuevo:', err);
            return { denied: true, newUser: true, profile: null };
        }
    }

    async function deleteDeniedAuthUser(user) {
        try {
            await user.delete();
        } catch (err) {
            console.warn('No se pudo eliminar el usuario rechazado de Firebase Auth:', err);
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
            id:              user.uid,
            name:            user.displayName || user.email,
            email:           user.email,
            invite_code:     inviteCode || null,
            created_at:      firebase.firestore.FieldValue.serverTimestamp(),
            last_login:      firebase.firestore.FieldValue.serverTimestamp()
        };
    }

    // ── HELPERS ──────────────────────────────────────────────────────────────

    function isAdmin(user) {
        return String(user.email || '').toLowerCase() === ADMIN_EMAIL;
    }

    function isBlockedProfile(profile) {
        return profile && profile.blocked === true;
    }

    /** Bloquea/desbloquea todos los botones de acceso */
    function lockAuthButtons(locked) {
        if (ui.googleLoginBtn)   ui.googleLoginBtn.disabled   = locked;
        if (ui.emailLoginBtn)    ui.emailLoginBtn.disabled    = locked;
        if (ui.emailRegisterBtn) ui.emailRegisterBtn.disabled = locked;
    }

    function unlockExistingUserLogin() {
        if (ui.googleLoginBtn)   ui.googleLoginBtn.disabled   = false;
        if (ui.emailLoginBtn)    ui.emailLoginBtn.disabled    = false;
        if (ui.emailRegisterBtn) {
            ui.emailRegisterBtn.disabled = true;
            ui.emailRegisterBtn.textContent = 'Validar código para registrarse';
        }
    }

    function setEmailButtonsLoading(loading) {
        if (ui.emailLoginBtn) {
            ui.emailLoginBtn.disabled    = loading;
            ui.emailLoginBtn.textContent = loading ? 'Entrando…' : 'Iniciar sesión';
        }
        if (ui.emailRegisterBtn) {
            ui.emailRegisterBtn.disabled = loading || skipInvite || !validatedInviteCode;
            ui.emailRegisterBtn.textContent = loading
                ? 'Registrando…'
                : (skipInvite ? 'Validar código para registrarse' : 'Registrarse con este correo');
        }
    }

    function showEmailError(msg, isInfo = false) {
        if (!ui.emailFormError) return;
        ui.emailFormError.textContent = msg;
        ui.emailFormError.classList.add('visible');
        if (isInfo) {
            ui.emailFormError.style.background = '#f0fdf4';
            ui.emailFormError.style.borderColor = '#bbf7d0';
            ui.emailFormError.style.color = '#15803d';
        } else {
            ui.emailFormError.style.background = '';
            ui.emailFormError.style.borderColor = '';
            ui.emailFormError.style.color = '';
        }
    }

    function clearEmailError() {
        if (!ui.emailFormError) return;
        ui.emailFormError.textContent = '';
        ui.emailFormError.classList.remove('visible');
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
    function friendlyAuthError(err) {
        const map = {
            'auth/invalid-email':            'El correo no tiene un formato válido.',
            'auth/user-not-found':           'No existe una cuenta con ese correo.',
            'auth/wrong-password':           'Contraseña incorrecta.',
            'auth/invalid-credential':       'Correo o contraseña incorrectos.',
            'auth/email-already-in-use':     'Ya existe una cuenta con ese correo. Prueba a iniciar sesión.',
            'auth/weak-password':            'La contraseña debe tener al menos 6 caracteres.',
            'auth/too-many-requests':        'Demasiados intentos fallidos. Espera unos minutos.',
            'auth/network-request-failed':   'Sin conexión. Revisa tu red.',
            'auth/popup-closed-by-user':     'Se cerró la ventana de acceso.',
            'auth/cancelled-popup-request':  'Se canceló la solicitud de acceso.'
        };
        return map[err.code] || `Error: ${err.message}`;
    }
});
