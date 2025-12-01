require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

app.use(express.static(path.join(__dirname, 'public')));

// === ГЛОБАЛЬНІ ЗМІННІ ===
let players = {}; 
let playerCharacters = {}; 
let votes = {};   
let actionsThisRound = {}; 

// === ТАЙМЕР І ФАЗИ ===
let timerInterval = null;
let timeLeft = 0;
let currentPhase = "LOBBY"; 
let currentRound = 0;

// === ЧЕРГА ===
let turnOrder = []; 
let currentTurnIndex = 0; 

// НАЛАШТУВАННЯ ЧАСУ
const TIMES = {
    INTRO: 120,    // Загальний час на знайомство
    DEBATE: 180,   // Загальний час на срач
    TURN: 30       // !!! ІНДИВІДУАЛЬНИЙ ЧАС НА ХІД (секунд)
};

io.on('connection', (socket) => {
    socket.on('join_game', (nickname) => {
        players[socket.id] = { name: nickname, isKicked: false, bonusTimeUsed: 0 };
        io.emit('update_player_list', players);
        
        if (currentPhase !== "LOBBY") {
            socket.emit('sync_timer', { time: timeLeft, phase: currentPhase, round: currentRound });
            if (turnOrder.length > 0) notifyTurn();
        }
        
        if (Object.keys(players).length === 1) socket.emit('set_admin');
    });

    // --- СТАРТ ГРИ ---
    socket.on('start_game_request', async () => {
        const playerCount = Object.keys(players).length;

        if (playerCount < 5) {
            socket.emit('error_message', `⚠ Для початку потрібно мінімум 5 гравців!`);
            socket.emit('reset_start_btn');
            return;
        }

        clearInterval(timerInterval);
        currentRound = 1;
        votes = {};
        actionsThisRound = {};
        
        for (let id in players) { 
            players[id].isKicked = false; 
            players[id].bonusTimeUsed = 0;
        }
        
        try {
            const prompt = `
            Згенеруй гру "Бункер" (JSON) для ${playerCount} гравців. 
            Умова: МІНІМУМ 2 місця, але менше ніж ${playerCount}.
            Поверни ТІЛЬКИ чистий JSON. Структура: 
            { 
                "scenario": { "title": "...", "description": "...", "places": 2, "duration": "..." }, 
                "players": [ 
                    { "profession": "...", "health": "...", "gender": "...", "age": "...", "hobby": "...", "inventory": "...", "trait": "..." } 
                ] 
            }`;
            
            const result = await model.generateContent(prompt);
            let text = result.response.text();
            const jsonStartIndex = text.indexOf('{');
            const jsonEndIndex = text.lastIndexOf('}');
            const cleanJson = text.substring(jsonStartIndex, jsonEndIndex + 1);
            const gameData = JSON.parse(cleanJson);

            global.currentScenarioData = gameData.scenario; 

            io.emit('scenario_update', { scenario: gameData.scenario, round: currentRound });

            const socketIds = Object.keys(players);
            playerCharacters = {}; 
            gameData.players.forEach((character, index) => {
                const id = socketIds[index];
                if (id) {
                    playerCharacters[id] = character;
                    io.to(id).emit('your_character', character);
                    setTimeout(() => {
                        revealTraitForPlayer(id, 'gender');
                        revealTraitForPlayer(id, 'age');
                    }, 1000);
                }
            });

            startPhase("INTRO");

        } catch (error) {
            console.error(error);
            socket.emit('error_message', "Помилка AI.");
            socket.emit('reset_start_btn');
        }
    });

    // --- БОНУСНИЙ ЧАС ---
    socket.on('add_time', () => {
        const p = players[socket.id];
        // Додавати час можна тільки в свій хід (якщо це фаза черги) або будь-коли в загальній фазі
        const isMyTurn = (turnOrder.length > 0 && turnOrder[currentTurnIndex] === socket.id);
        const isGlobalPhase = (turnOrder.length === 0 && currentPhase !== "LOBBY");

        if (p && !p.isKicked && p.bonusTimeUsed < 2 && (isMyTurn || isGlobalPhase)) {
            p.bonusTimeUsed++;
            timeLeft += 30; // Додаємо 30 сек до поточного таймера (індивідуального або загального)
            io.emit('timer_update', { time: timeLeft, phase: currentPhase });
            io.emit('new_message', { user: "СИСТЕМА", text: `⏳ ${p.name} використав бонус +30 с!` });
            socket.emit('bonus_used_update', p.bonusTimeUsed);
        } else if (!isMyTurn && !isGlobalPhase) {
            socket.emit('error_message', "Час можна додавати тільки у свій хід!");
        }
    });

    // --- ВІДКРИТТЯ КАРТ ---
    socket.on('reveal_trait', (traitName) => {
        if (currentPhase !== "REVEAL") return;
        const activePlayerId = turnOrder[currentTurnIndex];
        if (socket.id !== activePlayerId) {
            socket.emit('error_message', "⛔ ЗАРАЗ НЕ ТВІЙ ХІД!");
            return;
        }
        if (actionsThisRound[socket.id]) return; 

        const success = revealTraitForPlayer(socket.id, traitName);
        if (success) {
            actionsThisRound[socket.id] = true;
            socket.emit('action_success');
            // Одразу переходимо до наступного, не чекаючи таймера
            clearInterval(timerInterval);
            nextTurn();
        }
    });

    // --- ГОЛОСУВАННЯ ---
    socket.on('submit_vote', (votedForId) => {
        if (currentPhase !== "VOTE") return;
        if (players[socket.id].isKicked || votes[socket.id]) return;
        const activePlayerId = turnOrder[currentTurnIndex];
        if (socket.id !== activePlayerId) {
            socket.emit('error_message', "⛔ ЗАРАЗ НЕ ТВІЙ ХІД!");
            return;
        }

        votes[socket.id] = votedForId;
        broadcastVotes(); 
        
        clearInterval(timerInterval);
        nextTurn();
    });

    socket.on('skip_phase', () => {
        // Дозволяємо тільки якщо гра вже йде (не в лобі)
        if (currentPhase !== "LOBBY") {
            io.emit('new_message', { user: "ADMIN", text: "⏩ Фазу пропущено примусово!" });
            
            // Якщо це фаза ходів, треба скинути індивідуальний таймер
            clearInterval(timerInterval);
            
            // Викликаємо стандартне завершення фази
            endPhase();
        }
    });

    // --- ФУНКЦІЇ КЕРУВАННЯ ФАЗАМИ ---

    function startPhase(phaseName) {
        currentPhase = phaseName;
        turnOrder = []; 
        clearInterval(timerInterval);

        let phaseTitle = "";
        switch(phaseName) {
            case "INTRO": phaseTitle = "РАУНД 1: ЗНАЙОМСТВО"; break;
            case "REVEAL": phaseTitle = `РАУНД ${currentRound}: ВІДКРИТТЯ КАРТ`; break;
            case "DEBATE": phaseTitle = `РАУНД ${currentRound}: ОБГОВОРЕННЯ`; break;
            case "VOTE": phaseTitle = `РАУНД ${currentRound}: ГОЛОСУВАННЯ`; break;
        }

        // Для загальних фаз (INTRO, DEBATE) ставимо довгий таймер
        if (phaseName === "INTRO" || phaseName === "DEBATE") {
            timeLeft = TIMES[phaseName];
            io.emit('phase_change', { phase: phaseName, title: phaseTitle, time: timeLeft });
            io.emit('new_message', { user: "СИСТЕМА", text: `🔔 ${phaseTitle} РОЗПОЧАТО.` });
            io.emit('turn_update', { activePlayerId: null }); // Нічий хід, всі говорять

            timerInterval = setInterval(() => {
                timeLeft--;
                io.emit('timer_tick', timeLeft);
                if (timeLeft <= 0) endPhase();
            }, 1000);
        } 
        // Для фаз дій (REVEAL, VOTE) запускаємо чергу
        else {
            io.emit('phase_change', { phase: phaseName, title: phaseTitle, time: TIMES.TURN }); 
            io.emit('new_message', { user: "СИСТЕМА", text: `🔔 ${phaseTitle}. Ходимо по черзі!` });
            
            // Формуємо чергу живих
            turnOrder = Object.keys(players).filter(id => !players[id].isKicked);
            currentTurnIndex = -1; // Щоб nextTurn почав з 0
            
            nextTurn(); // Запускаємо першого
        }
    }

    // Запускає таймер для конкретного гравця
    function nextTurn() {
        currentTurnIndex++;

        // Якщо всі походили
        if (currentTurnIndex >= turnOrder.length) {
            io.emit('turn_update', { activePlayerId: null });
            io.emit('new_message', { user: "СИСТЕМА", text: "✅ Всі зробили хід. Фаза завершується..." });
            setTimeout(() => endPhase(), 2000);
            return;
        }

        const activeId = turnOrder[currentTurnIndex];
        const activeName = players[activeId].name;

        // Скидаємо таймер на стандартний час ходу (наприклад 30 сек)
        timeLeft = TIMES.TURN;
        
        io.emit('turn_update', { activePlayerId: activeId, activeName: activeName });
        // Оновлюємо таймер на клієнті (щоб цифри стрибнули назад на 30)
        io.emit('timer_tick', timeLeft); 

        // Запускаємо персональний таймер
        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            timeLeft--;
            io.emit('timer_tick', timeLeft);

            if (timeLeft <= 0) {
                clearInterval(timerInterval);
                handleTurnTimeout(activeId); // Час вийшов - караємо
            }
        }, 1000);
    }

    // Автоматична дія, якщо гравець заснув
    function handleTurnTimeout(playerId) {
        if (currentPhase === "REVEAL") {
            // Відкриваємо рандомну
            revealRandomTrait(playerId);
            actionsThisRound[playerId] = true;
        } 
        else if (currentPhase === "VOTE") {
            // Голос проти себе
            votes[playerId] = playerId;
            broadcastVotes();
            io.emit('new_message', { user: "СИСТЕМА", text: `⚠ ${players[playerId].name} проспав хід і голосує проти себе!` });
        }
        
        // Йдемо до наступного
        nextTurn();
    }

    function endPhase() {
        clearInterval(timerInterval);

        if (currentPhase === "INTRO") startPhase("REVEAL");
        else if (currentPhase === "REVEAL") {
            actionsThisRound = {}; 
            startPhase("DEBATE");
        }
        else if (currentPhase === "DEBATE") startPhase("VOTE");
        else if (currentPhase === "VOTE") {
            processVotingResults();
        }
    }

    async function processVotingResults() {
        let voteCounts = {};
        Object.values(votes).forEach(target => { voteCounts[target] = (voteCounts[target] || 0) + 1; });

        let maxVotes = 0;
        let loserId = null;
        for (let [target, count] of Object.entries(voteCounts)) {
            if (count > maxVotes) { maxVotes = count; loserId = target; }
        }

        if (loserId && players[loserId]) {
            players[loserId].isKicked = true;
            io.emit('voting_result', { kickedPlayer: players[loserId].name, message: `🛑 ВИГНАНО: ${players[loserId].name}` });
            io.emit('update_player_list', players);
            
            const survivorsCount = Object.values(players).filter(p => !p.isKicked).length;
            const placesInBunker = global.currentScenarioData ? global.currentScenarioData.places : 2;

            if (survivorsCount <= placesInBunker) {
                finishGameAutomatic();
            } else {
                currentRound++;
                votes = {};
                setTimeout(() => { startPhase("REVEAL"); }, 5000);
            }

        } else {
             setTimeout(() => { startPhase("REVEAL"); }, 3000);
        }
    }

async function finishGameAutomatic() {
        io.emit('new_message', { user: "СИСТЕМА", text: "⚙ ОБРОБКА ДАНИХ... АНАЛІЗ ЙМОВІРНОСТЕЙ..." });
        clearInterval(timerInterval);
        
        let survivors = [];
        for (let id in players) {
            if (!players[id].isKicked && playerCharacters[id]) {
                survivors.push({ 
                    name: players[id].name, 
                    ...playerCharacters[id] // Розгортаємо всі характеристики
                });
            }
        }
        
        try {
            const prompt = `
            Ти — цинічний AI-симулятор постапокаліпсису. Твоє завдання — прорахувати долю групи людей, що зачинилися в бункері.
            Будь жорстким, логічним і реалістичним. Ніяких хепі-ендів, якщо команда слабка.

            ВХІДНІ ДАНІ:
            1. КАТАСТРОФА: ${JSON.stringify(global.currentScenarioData)}
            2. ГРУПА ВИЖИВШИХ: ${JSON.stringify(survivors)}

            АЛГОРИТМ АНАЛІЗУ (Продумай це "про себе", не пиши це в відповідь):
            1. БІОЛОГІЯ: Чи є чоловіки і жінки репродуктивного віку (20-45)? Якщо ні — популяція вимре.
            2. МЕДИЦИНА: Чи є лікар? Чи є аптечка? Якщо є хворі, але немає лікаря — вони помруть і заразять інших.
            3. ПСИХОЛОГІЯ: Чи є психопати, маніяки або ворожі професії? Вони можуть вбити інших.
            4. РЕСУРСИ: Чи є агрономи/фермери для їжі? Чи є інженери для ремонту бункера?

            ТВОЯ ВІДПОВІДЬ МАЄ БУТИ ХУДОЖНЬОЮ ІСТОРІЄЮ УКРАЇНСЬКОЮ МОВОЮ (6-8 речень):
            - Опиши, як пройшли роки в бункері.
            - Згадай конкретних гравців та як їхні предмети/риси допомогли АБО знищили групу.
            - Якщо хтось помер — напиши як і чому (наприклад: "Олег збожеволів через фобію темряви і відчинив люк...").
            
            ВЕРДИКТ:
            В кінці напиши чітко великими літерами одне з двох:
            [ГРУПА ВИЖИЛА ТА ВІДРОДИЛА ЛЮДСТВО] 
            або 
            [БУНКЕР СТАВ МОГИЛОЮ. ЛЮДСТВО ЗАГИНУЛО]
            `;
            
            const result = await model.generateContent(prompt);
            io.emit('game_over', result.response.text());

        } catch (e) { 
            console.error(e);
            io.emit('game_over', "СИСТЕМА ПОШКОДЖЕНА... ДАНІ ВТРАЧЕНО... (Помилка AI)");
        }
    }

    function revealTraitForPlayer(id, trait) {
        if(playerCharacters[id]) {
            io.emit('player_revealed_trait', { playerId: id, trait: trait, value: playerCharacters[id][trait] });
            return true;
        }
        return false;
    }

    function revealRandomTrait(id) {
        const traits = ['profession', 'health', 'hobby', 'inventory', 'trait'];
        const randomTrait = traits[Math.floor(Math.random() * traits.length)];
        revealTraitForPlayer(id, randomTrait);
        io.emit('new_message', { user: "СИСТЕМА", text: `🎲 ${players[id].name} не встиг! Відкрито: ${randomTrait}` });
    }

    function broadcastVotes() {
        let voteCounts = {};
        for (let id in players) { if (!players[id].isKicked) voteCounts[id] = 0; }
        Object.values(votes).forEach(target => { if (voteCounts[target] !== undefined) voteCounts[target]++; });
        
        io.emit('vote_update', { 
            counts: voteCounts, 
            totalVoted: Object.keys(votes).length, 
            needed: Object.values(players).filter(p => !p.isKicked).length 
        });
    }
    
    // --- SOCKETS ---
    socket.on('send_message', (text) => {
        const name = players[socket.id]?.name || "Анонім";
        io.emit('new_message', { user: name, text: text });
    });
    
    socket.on('disconnect', () => { delete players[socket.id]; io.emit('update_player_list', players); });
});

const PORT = 3000;
server.listen(PORT, () => { console.log(`http://localhost:${PORT}`); });