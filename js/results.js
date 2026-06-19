document.addEventListener('DOMContentLoaded', () => {
    const rawResults = sessionStorage.getItem('examResults');
    if (!rawResults) {
        alert('No hay un examen reciente para mostrar.');
        window.location.href = 'dashboard.html';
        return;
    }

    const { questions, userAnswers, summary, passingScore = 15 } = JSON.parse(rawResults);
    const answered = summary.correct + summary.incorrect;

    document.getElementById('res-respondadas').textContent = answered;
    document.getElementById('res-no-respondidas').textContent = summary.unanswered;
    document.getElementById('res-bien').textContent = summary.correct;
    document.getElementById('res-mal').textContent = summary.incorrect;

    const resultTitle = document.getElementById('result-title');
    const passed = summary.correct >= passingScore;
    resultTitle.textContent = passed
        ? `APTO: ${summary.correct} de 25 aciertos`
        : `NO APTO: ${summary.correct} de 25 aciertos`;
    resultTitle.className = passed ? 'result-title passed' : 'result-title failed';

    const body = document.getElementById('tabla-preguntas-cuerpo');
    body.innerHTML = questions.map((question, index) => {
        const selectedKey = userAnswers[index] ?? null;
        const selectedOption = question.options.find(option => option.key === selectedKey);
        const correctOption = question.options.find(
            option => option.key === question.correct_answer
        );
        const correctAnswerText = formatOption(correctOption);
        let stateLabel = 'No respondida';
        let stateClass = 'no-respondidas';
        let simpleExplanation =
            `No elegiste una respuesta. La respuesta correcta es ${correctAnswerText}.`;

        if (selectedKey === question.correct_answer) {
            stateLabel = 'Correcta';
            stateClass = 'bien';
            simpleExplanation =
                `¡Muy bien! Elegiste la respuesta correcta: ${correctAnswerText}.`;
        } else if (selectedKey !== null) {
            stateLabel = 'Incorrecta';
            stateClass = 'mal';
            simpleExplanation =
                `Esta respuesta no es correcta. La respuesta correcta es ${correctAnswerText}.`;
        }

        const state = `
            <span
                class="result-with-help"
                tabindex="0"
                aria-describedby="help-${index}"
                title="${escapeHtml(simpleExplanation)}"
            >
                <span class="badge ${stateClass}">${stateLabel}</span>
                <span id="help-${index}" class="simple-tooltip" role="tooltip">
                    ${escapeHtml(simpleExplanation)}
                </span>
            </span>
        `;

        return `
            <tr>
                <td class="center-text">${index + 1}</td>
                <td>
                    <strong>${escapeHtml(question.question_text)}</strong>
                    <div class="answer-note">Correcta: ${escapeHtml(correctAnswerText)}</div>
                </td>
                <td>${escapeHtml(selectedOption ? formatOption(selectedOption) : '—')}</td>
                <td>${state}</td>
            </tr>
        `;
    }).join('');

    function formatOption(option) {
        return option ? `${option.key.toUpperCase()}) ${option.text}` : 'No disponible';
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
