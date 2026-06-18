document.addEventListener('DOMContentLoaded', async function() {
    // 1. Asegurar e inicializar Firestore correctamente en modo compatibilidad
    if (typeof firebase === 'undefined') {
        console.error("El SDK de Firebase no se encuentra disponible.");
        return;
    }
    
    // Forzamos la obtención de la instancia activa de la base de datos
    const db = firebase.apps.length ? firebase.firestore() : null;
    if (!db) {
        console.error("Firebase no ha sido inicializado correctamente.");
        return;
    }
    
    // 2. Obtener la información almacenada provisionalmente tras el test
    const examDataRaw = sessionStorage.getItem('examResults');
    if (!examDataRaw) {
        alert('No se registran datos del examen para analizar.');
        window.location.href = 'dashboard.html';
        return;
    }

    const { questions, userAnswers } = JSON.parse(examDataRaw);

    let respondidas = 0;
    let noRespondidas = 0;
    let bien = 0;
    let mal = 0;

    const tablaCuerpo = document.getElementById('tabla-preguntas-cuerpo');
    tablaCuerpo.innerHTML = ''; 

    // 3. Iterar sobre las preguntas para computar contadores y renderizar
    for (let index = 0; index < questions.length; index++) {
        const q = questions[index];
        const userAnswer = userAnswers[index];
        
        let estadoActualHtml = '';
        let tuRespuestaTexto = userAnswer ? userAnswer.toUpperCase() : 'Ninguna';

        if (userAnswer === null || userAnswer === undefined) {
            noRespondidas++;
            estadoActualHtml = `<span class="badge no-respondidas">No Respondida</span>`;
            tuRespuestaTexto = '—';
        } else if (userAnswer === q.correct_answer) {
            respondidas++;
            bien++;
            estadoActualHtml = `<span class="badge bien">Correcta</span>`;
        } else {
            respondidas++;
            mal++;
            estadoActualHtml = `<span class="badge mal">Incorrecta</span>`;
        }

        // Generación de ID limpia basada en el texto de la pregunta
        const questionIdDoc = q.id || q.question_text.replace(/[^a-zA-Z0-9]/g, "").substring(0, 30);
        let totalCorrectasHistorico = 0;
        let totalIncorrectasHistorico = 0;

        // 4. Consultar contadores globales en Firestore usando promesas seguras
        try {
            const doc = await db.collection('question_stats').doc(questionIdDoc).get();
            if (doc.exists) {
                const data = doc.data();
                totalCorrectasHistorico = data.total_correct || 0;
                totalIncorrectasHistorico = data.total_incorrect || 0;
            }
        } catch (e) {
            console.error("Error leyendo estadísticas del ítem:", e);
        }

        // 5. Añadir la fila estructurada en el HTML de la tabla
        const fila = document.createElement('tr');
        fila.innerHTML = `
            <td class="center-text">${index + 1}</td>
            <td><strong>${q.question_text}</strong></td>
            <td style="font-weight: bold;" class="center-text">${tuRespuestaTexto}</td>
            <td>${estadoActualHtml}</td>
            <td style="color: #276749; font-weight: bold;" class="center-text">${totalCorrectasHistorico}</td>
            <td style="color: #9b2c2c; font-weight: bold;" class="center-text">${totalIncorrectasHistorico}</td>
        `;
        tablaCuerpo.appendChild(fila);
    }

    // 6. Rellenar las tarjetas del bloque global de estadísticas superiores
    document.getElementById('res-respondadas').textContent = respondidas;
    document.getElementById('res-no-respondidas').textContent = noRespondidas;
    document.getElementById('res-bien').textContent = bien;
    document.getElementById('res-mal').textContent = mal;
});