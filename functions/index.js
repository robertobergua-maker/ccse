'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp }      = require('firebase-admin/app');
const { getAuth }            = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

initializeApp();

const ADMIN_EMAIL   = 'roberto.bergua@gmail.com';
const CHUNK_SIZE    = 450; // límite de operaciones por batch de Firestore

/**
 * deleteUser — borra completamente un usuario:
 *   1. Firebase Auth (cuenta de acceso)
 *   2. Firestore: users/{uid}
 *   3. Firestore: exams donde user_id == uid
 *   4. Firestore: exam_answers donde user_id == uid
 *   5. Firestore: user_question_stats donde user_id == uid
 *
 * Solo puede llamarla el administrador (verificado por email en el token).
 */
exports.deleteUser = onCall(
    { region: 'europe-west1' },
    async (request) => {
        // ── Verificar que el llamante es el admin ────────────────────────────
        const caller = request.auth;
        if (!caller) {
            throw new HttpsError('unauthenticated', 'Se requiere autenticación.');
        }
        if (!caller.token.email_verified || String(caller.token.email || '').toLowerCase() !== ADMIN_EMAIL) {
            throw new HttpsError('permission-denied', 'Solo el administrador puede borrar usuarios.');
        }

        const { uid } = request.data;
        if (!uid || typeof uid !== 'string') {
            throw new HttpsError('invalid-argument', 'Se requiere un UID válido.');
        }

        // Evitar que el admin se borre a sí mismo
        if (uid === caller.uid) {
            throw new HttpsError('failed-precondition', 'El administrador no puede borrarse a sí mismo.');
        }

        const db   = getFirestore();
        const auth = getAuth();

        const result = {
            uid,
            authDeleted:    false,
            userDocDeleted: false,
            examsDeleted:   0,
            answersDeleted: 0,
            statsDeleted:   0
        };

        // ── 1. Eliminar cuenta de Firebase Auth ──────────────────────────────
        try {
            await auth.deleteUser(uid);
            result.authDeleted = true;
        } catch (err) {
            // Si no existe en Auth, continuamos (puede ser un usuario solo en Firestore)
            if (err.code !== 'auth/user-not-found') {
                throw new HttpsError('internal', `Error al eliminar cuenta Auth: ${err.message}`);
            }
        }

        // ── 2. Eliminar perfil de usuario ────────────────────────────────────
        try {
            await db.collection('users').doc(uid).delete();
            result.userDocDeleted = true;
        } catch (err) {
            console.error('Error al eliminar users doc:', err);
        }

        // ── 3–5. Eliminar datos relacionados en paralelo ─────────────────────
        const [examsSnap, answersSnap, statsSnap] = await Promise.all([
            db.collection('exams').where('user_id', '==', uid).get(),
            db.collection('exam_answers').where('user_id', '==', uid).get(),
            db.collection('user_question_stats').where('user_id', '==', uid).get()
        ]);

        result.examsDeleted   = examsSnap.size;
        result.answersDeleted = answersSnap.size;
        result.statsDeleted   = statsSnap.size;

        const allRefs = [
            ...examsSnap.docs.map(d => d.ref),
            ...answersSnap.docs.map(d => d.ref),
            ...statsSnap.docs.map(d => d.ref)
        ];

        // Borrar en chunks de 450 para no superar el límite de batch
        for (let i = 0; i < allRefs.length; i += CHUNK_SIZE) {
            const batch = db.batch();
            allRefs.slice(i, i + CHUNK_SIZE).forEach(ref => batch.delete(ref));
            await batch.commit();
        }

        console.info(`Usuario ${uid} eliminado por ${caller.token.email}. Auth:${result.authDeleted} exams:${result.examsDeleted} answers:${result.answersDeleted} stats:${result.statsDeleted}`);

        return result;
    }
);
