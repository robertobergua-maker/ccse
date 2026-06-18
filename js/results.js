document.addEventListener('DOMContentLoaded', async function() {
    // Comprobar que firebase esté inicializado correctamente
    if (typeof firebase === 'undefined') {
        console.error("Firebase SDK no está cargado.");
        return;
    }
    
    const db = firebase.firestore();
    
    // 1. Obtener la información del intento desde el almacenamiento de sesión
    const examDataRaw = sessionStorage.getItem('examResults');
    if (!examDataRaw) {
        alert('No se encontraron resultados de exámenes interactivos disponibles.');
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

    // 2. Procesar cíclicamente cada pregunta del examen finalizado
    for (let index = 0; index < questions.length; index++) {
        const q = questions[index];
        const userAnswer = userAnswers[index];
        
        let estadoActualHtml = '';
        let tuRespuestaTexto = userAnswer ? userAnswer.toUpperCase() : 'Ninguna';

        // Clasificación del estado de la respuesta actual
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

        // ID de documento unificado idéntico al generado en examen.js
        const questionIdDoc = q.id || q.question_text.replace(/[^a-zA-Z0-9]/g, "").substring(0, 30);
        let totalCorrectasHistorico = 0;
        let totalIncorrectasHistorico = 0;

        // 3. Consulta de datos acumulativos en tiempo real desde Cloud Firestore
        try {
            const doc = await db.collection('question_stats').doc(questionIdDoc).get();
            if (doc.exists) {
                const data = doc.data();
                totalCorrectasHistorico = data.total_correct || 0;
                totalIncorrectasHistorico = data.total_incorrect || 0;
            }
        } catch (e) {
            console.error("Error recuperando histórico de documento de pregunta:", e);
        }

        // 4. Inserción de la fila estructurada en el DOM
        const fila = document.createElement('tr');
        fila.innerHTML = `
            <td>${index + 1}</td>
            <td><strong>${q.question_text}</strong></td>
            <td style="text-align: center; font-weight: bold;">${tuRespuestaTexto}</td>
            <td>${estadoActualHtml}</td>
            <td style="color: #276749; font-weight: bold; text-align: center;">${totalCorrectasHistorico}</td>
            <td style="color: #9b2c2c; font-weight: bold; text-align: center;">${totalIncorrectasHistorico}</td>
        `;
        tablaCuerpo.appendChild(fila);
    }

    // 5. Actualización final de los contadores en las tarjetas superiores
    document.getElementById('res-respondadas').textContent = respondidas;
    document.getElementById('res-no-respondidas').textContent = noRespondidas;
    document.getElementById('res-bien').textContent = bien;
    document.getElementById('res-mal').textContent = mal;
});