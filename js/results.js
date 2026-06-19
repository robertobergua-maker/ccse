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
        const explanation = getSimpleExplanation(question, correctOption);
        let stateLabel = 'No respondida';
        let stateClass = 'no-respondidas';
        let simpleExplanation =
            `No elegiste una respuesta. ${explanation}`;

        if (selectedKey === question.correct_answer) {
            stateLabel = 'Correcta';
            stateClass = 'bien';
            simpleExplanation =
                `¡Muy bien! ${explanation}`;
        } else if (selectedKey !== null) {
            stateLabel = 'Incorrecta';
            stateClass = 'mal';
            simpleExplanation =
                `Tu respuesta no es correcta. ${explanation}`;
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

    function getSimpleExplanation(question, correctOption) {
        if (question.explanation_simple) {
            return question.explanation_simple;
        }

        const answer = cleanSentence(correctOption?.text || 'No disponible');
        const prompt = cleanSentence(question.question_text)
            .replace(/^¿/, '')
            .replace(/\?$/, '')
            .replace(/…$/, '')
            .trim();

        if (question.question_type === 'true_false') {
            if (question.correct_answer === 'a') {
                return `La frase es verdadera. Puedes recordarla así: ${prompt}.`;
            }
            return `La frase es falsa. No debes tomar como correcto lo que dice: “${prompt}”.`;
        }

        const howNamed = prompt.match(/^Cómo se (llama|llaman) (.+)$/i);
        if (howNamed) {
            const verb = howNamed[1].toLowerCase();
            return `${capitalize(howNamed[2])} se ${verb} ${lowercaseFirst(answer)}.`;
        }

        const who = prompt.match(/^Quién(?:es)? (.+)$/i);
        if (who) {
            return `${answer} ${lowercaseFirst(who[1])}.`;
        }

        const where = prompt.match(/^Dónde (está|están|vive|viven|se encuentra|se encuentran) (.+)$/i);
        if (where) {
            return `${capitalize(where[2])} ${where[1].toLowerCase()} ${lowercaseFirst(answer)}.`;
        }

        const whatIs = prompt.match(/^Cuál es (.+)$/i);
        if (whatIs) {
            return `${capitalize(whatIs[1])} es ${lowercaseFirst(answer)}.`;
        }

        const howManyExist = prompt.match(/^Cuánt(?:os|as) (.+?) hay (.+)$/i);
        if (howManyExist) {
            return `${capitalize(howManyExist[2])} hay ${lowercaseFirst(answer)} ${howManyExist[1].toLowerCase()}.`;
        }

        const howManyHas = prompt.match(/^Cuánt(?:os|as) (.+?) tiene (.+)$/i);
        if (howManyHas) {
            return `${capitalize(howManyHas[2])} tiene ${lowercaseFirst(answer)} ${howManyHas[1].toLowerCase()}.`;
        }

        const whichOne = prompt.match(
            /^Cuál de (?:estos|estas|los siguientes|las siguientes) .+? (se .+|es .+|tiene .+|está .+|permite .+)$/i
        );
        if (whichOne) {
            return `${answer} ${lowercaseFirst(whichOne[1])}.`;
        }

        if (/^Cómo /i.test(prompt)) {
            return `La forma correcta es ${lowercaseFirst(answer)}.`;
        }

        if (/…$/.test(question.question_text.trim())) {
            return `${capitalize(prompt)} ${lowercaseFirst(answer)}.`;
        }

        return `La respuesta correcta es ${answer}. Esta es la idea que debes recordar para esta pregunta.`;
    }

    function cleanSentence(value) {
        return String(value).trim().replace(/[.\s]+$/, '');
    }

    function capitalize(value) {
        return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
    }

    function lowercaseFirst(value) {
        if (!value) return value;
        if (/^[A-ZÁÉÍÓÚÑ]{2,}\b/.test(value)) return value;
        return value.charAt(0).toLowerCase() + value.slice(1);
    }

    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value);
        return element.innerHTML;
    }
});
