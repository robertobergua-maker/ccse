document.addEventListener('DOMContentLoaded', function() {
    const auth = firebase.auth();
    const db = firebase.firestore(); // Ensure db is initialized
    let currentUser = null;

    let examQuestions = []; 
    let userAnswers = {};   
    let timerInterval = null;

    const ui = {
        examContainer: document.getElementById('exam-container'),
        submitExamBtn: document.getElementById('submit-exam-btn'),
        timer: document.getElementById('timer')
    };

    auth.onAuthStateChanged(user => {
        if (user) {
            currentUser = user;
            startNewExam();
        } else {
            window.location.href = 'login.html';
        }
    });

    async function startNewExam() {
        try {
            const response = await fetch('preguntas.json');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const allQuestions = await response.json();
            
            examQuestions = shuffleArray(allQuestions).slice(0, 25);
            userAnswers = {}; 
            
            renderExam(examQuestions);
            startTimer(45 * 60);
        } catch (error) {
            console.error("Could not start new exam:", error);
            ui.examContainer.innerHTML = "<p>Error al cargar las preguntas del examen. Por favor, intentalo de nuevo más tarde.</p>";
        }
    }

    function renderExam(questions) {
        let examHtml = '';
        questions.forEach((q, index) => {
            const questionId = index;
            examHtml += `
                <div class="question-block" id="question-${questionId}">
                    <h3>Pregunta ${index + 1}</h3>
                    <p>${q.question_text}</p>
                    <div class="options" data-question-id="${questionId}">
            `;
            if (q.question_type === 'multiple_choice') {
                examHtml += `
                    <label class="option"><input type="radio" name="q${questionId}" value="a"> A) ${q.option_a}</label>
                    <label class="option"><input type="radio" name="q${questionId}" value="b"> B) ${q.option_b}</label>
                    <label class="option"><input type="radio" name="q${questionId}" value="c"> C) ${q.option_c}</label>
                `;
            } else if (q.question_type === 'true_false') {
                examHtml += `
                    <label class="option"><input type="radio" name="q${questionId}" value="true"> Verdadero</label>
                    <label class="option"><input type="radio" name="q${questionId}" value="false"> Falso</label>
                `;
            }
            examHtml += `</div></div>`;
        });
        ui.examContainer.innerHTML = examHtml;
        addOptionListeners();
    }

    function addOptionListeners() {
        const options = document.querySelectorAll('.option input');
        options.forEach(option => {
            option.addEventListener('change', (e) => {
                const questionId = e.target.name.substring(1);
                userAnswers[questionId] = e.target.value;

                document.querySelectorAll(`input[name="q${questionId}"]`).forEach(opt => {
                    opt.parentElement.classList.remove('selected');
                });
                e.target.parentElement.classList.add('selected');
            });
        });
    }

    ui.submitExamBtn.addEventListener('click', () => {
        if (confirm('¿Estás seguro de que quieres finalizar y corregir el examen?')) {
            clearInterval(timerInterval);
            finishExam();
        }
    });

    async function finishExam() {
        // First, save the summary to Firestore for the history
        try {
            let correctCount = 0;
            let incorrectCount = 0;
            let unansweredCount = 0;

            examQuestions.forEach((question, index) => {
                const userAnswer = userAnswers[index];
                if (userAnswer === null || userAnswer === undefined) {
                    unansweredCount++;
                } else if (userAnswer === question.correct_answer) {
                    correctCount++;
                } else {
                    incorrectCount++;
                }
            });

            const passed = correctCount >= 15;

            await db.collection('exams').add({
                user_id: currentUser.uid,
                finished_at: firebase.firestore.FieldValue.serverTimestamp(),
                score_correct: correctCount,
                score_incorrect: incorrectCount,
                score_unanswered: unansweredCount,
                total_questions: examQuestions.length,
                passed: passed,
                exam_mode: 'simulacro_oficial'
            });
        } catch (error) {
            console.error("Error saving exam history to Firestore:", error);
        }

        // Second, save full results to sessionStorage for the immediate results page
        sessionStorage.setItem('examResults', JSON.stringify({
            questions: examQuestions,
            userAnswers: userAnswers
        }));

        // Finally, redirect to the results page
        window.location.href = 'results.html';
    }
    
    function startTimer(duration) {
        let timer = duration, minutes, seconds;
        clearInterval(timerInterval);
        timerInterval = setInterval(function () {
            minutes = parseInt(timer / 60, 10);
            seconds = parseInt(timer % 60, 10);

            minutes = minutes < 10 ? "0" + minutes : minutes;
            seconds = seconds < 10 ? "0" + seconds : seconds;

            ui.timer.textContent = minutes + ":" + seconds;

            if (--timer < 0) {
                clearInterval(timerInterval);
                alert('¡Tiempo agotado! El examen se corregirá automáticamente.');
                finishExam();
            }
        }, 1000);
    }

    function shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
});