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

// === ГОЛОВНЕ СХОВИЩЕ КІМНАТ ===
// Структура:
// rooms = {
//    "CODE12": {
//       players: {},
//       scenario: {},
//       gameState: { phase, round, timeLeft, turnOrder, ... },
//       timerInterval: null
//    }
// }
const rooms = {};

const TIMES = { INTRO: 120, DEBATE: 180, TURN: 30 };

// Допоміжна функція генерації коду кімнати (4 символи)
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
    
    // 1. СТВОРЕННЯ КІМНАТИ
    socket.on('create_room', (nickname) => {
        const roomId = generateRoomCode();
        
        // Ініціалізація нової кімнати
        rooms[roomId] = {
            id: roomId,
            players: {},
            playerCharacters: {},
            votes: {},
            actionsThisRound: {},
            scenario: null,
            
            // Стан гри
            phase: "LOBBY",
            round: 0,
            timeLeft: 0,
            timerInterval: null,
            
            // Черга
            turnOrder: [],
            currentTurnIndex: 0
        };

        joinRoom(socket, roomId, nickname, true); // true = адмін
    });

    // 2. ПРИЄДНАННЯ ДО КІМНАТИ
    socket.on('join_room', ({ roomId, nickname }) => {
        roomId = roomId.toUpperCase();
        
        if (!rooms[roomId]) {
            socket.emit('error_message', "❌ Кімнати з таким кодом не існує!");
            return;
        }
        
        // Якщо гра вже йде і гравця там не було - можна заборонити, але поки пускаємо
        joinRoom(socket, roomId, nickname, false);
    });

    function joinRoom(socket, roomId, nickname, isAdmin) {
        const room = rooms[roomId];
        
        // Додаємо гравця в об'єкт кімнати
        room.players[socket.id] = { 
            name: nickname, 
            isKicked: false, 
            bonusTimeUsed: 0,
            isAdmin: isAdmin 
        };

        socket.join(roomId); // Socket.io магія - підключаємо сокет до каналу
        socket.data.roomId = roomId; // Зберігаємо ID кімнати в самому сокеті
        
        // Відправляємо дані клієнту
        socket.emit('room_joined', { roomId: roomId, isAdmin: isAdmin });
        io.to(roomId).emit('update_player_list', room.players); // Тільки в цю кімнату!

        // Якщо гра вже йде - синхронізуємо
        if (room.phase !== "LOBBY") {
            socket.emit('sync_state', { 
                phase: room.phase, 
                time: room.timeLeft, 
                round: room.round,
                scenario: room.scenario 
            });
            // Якщо є черга - показати чий хід
            if(room.turnOrder.length > 0) notifyTurn(roomId);
        }
    }

    // 3. СТАРТ ГРИ
    socket.on('start_game_request', async () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];

        const playerCount = Object.keys(room.players).length;
        if (playerCount < 5) {
            socket.emit('error_message', `⚠ Мінімум 5 гравців! (Зараз: ${playerCount})`);
            socket.emit('reset_start_btn');
            return;
        }

        // Скидання стану
        clearInterval(room.timerInterval);
        room.round = 1;
        room.votes = {};
        room.actionsThisRound = {};
        for (let id in room.players) { 
            room.players[id].isKicked = false; 
            room.players[id].bonusTimeUsed = 0;
        }

        try {
            const prompt = `Згенеруй гру "Бункер" (JSON) для ${playerCount} гравців. Умова: МІНІМУМ 2 місця, але менше ніж ${playerCount}. Поверни ТІЛЬКИ чистий JSON. Структура: { "scenario": { "title": "...", "description": "...", "places": 2, "duration": "..." }, "players": [ { "profession": "...", "health": "...", "gender": "...", "age": "...", "hobby": "...", "inventory": "...", "trait": "..." } ] }`;
            const result = await model.generateContent(prompt);
            let text = result.response.text();
            const cleanJson = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
            const gameData = JSON.parse(cleanJson);

            room.scenario = gameData.scenario;
            io.to(roomId).emit('scenario_update', { scenario: room.scenario, round: room.round });

            const socketIds = Object.keys(room.players);
            room.playerCharacters = {}; 
            
            gameData.players.forEach((character, index) => {
                const id = socketIds[index];
                if (id) {
                    room.playerCharacters[id] = character;
                    io.to(id).emit('your_character', character);
                    setTimeout(() => {
                        revealTrait(roomId, id, 'gender');
                        revealTrait(roomId, id, 'age');
                    }, 1000);
                }
            });

            startPhase(roomId, "INTRO");

        } catch (error) {
            console.error(error);
            socket.emit('error_message', "Помилка AI.");
            socket.emit('reset_start_btn');
        }
    });

    // --- ФУНКЦІЇ УПРАВЛІННЯ КІМНАТОЮ ---

    function startPhase(roomId, phaseName) {
        const room = rooms[roomId];
        if(!room) return;

        room.phase = phaseName;
        room.turnOrder = []; 
        clearInterval(room.timerInterval);

        let title = "";
        switch(phaseName) {
            case "INTRO": title = "РАУНД 1: ЗНАЙОМСТВО"; break;
            case "REVEAL": title = `РАУНД ${room.round}: ВІДКРИТТЯ`; break;
            case "DEBATE": title = `РАУНД ${room.round}: ОБГОВОРЕННЯ`; break;
            case "VOTE": title = `РАУНД ${room.round}: ГОЛОСУВАННЯ`; break;
        }

        // Загальні фази
        if (phaseName === "INTRO" || phaseName === "DEBATE") {
            room.timeLeft = TIMES[phaseName];
            io.to(roomId).emit('phase_change', { phase: phaseName, title: title, time: room.timeLeft });
            io.to(roomId).emit('turn_update', { activePlayerId: null });

            room.timerInterval = setInterval(() => {
                room.timeLeft--;
                io.to(roomId).emit('timer_tick', room.timeLeft);
                if (room.timeLeft <= 0) endPhase(roomId);
            }, 1000);
        } 
        // Покрокові фази
        else {
            io.to(roomId).emit('phase_change', { phase: phaseName, title: title, time: TIMES.TURN }); 
            room.turnOrder = Object.keys(room.players).filter(id => !room.players[id].isKicked);
            room.currentTurnIndex = -1;
            nextTurn(roomId);
        }
    }

    function nextTurn(roomId) {
        const room = rooms[roomId];
        room.currentTurnIndex++;

        if (room.currentTurnIndex >= room.turnOrder.length) {
            io.to(roomId).emit('turn_update', { activePlayerId: null });
            setTimeout(() => endPhase(roomId), 1500);
            return;
        }

        const activeId = room.turnOrder[room.currentTurnIndex];
        room.timeLeft = TIMES.TURN;
        
        io.to(roomId).emit('turn_update', { activePlayerId: activeId, activeName: room.players[activeId].name });
        io.to(roomId).emit('timer_tick', room.timeLeft); 

        clearInterval(room.timerInterval);
        room.timerInterval = setInterval(() => {
            room.timeLeft--;
            io.to(roomId).emit('timer_tick', room.timeLeft);
            if (room.timeLeft <= 0) {
                clearInterval(room.timerInterval);
                handleTimeout(roomId, activeId);
            }
        }, 1000);
    }

    function handleTimeout(roomId, playerId) {
        const room = rooms[roomId];
        if (room.phase === "REVEAL") {
            const traits = ['profession', 'health', 'hobby', 'inventory', 'trait'];
            revealTrait(roomId, playerId, traits[Math.floor(Math.random()*traits.length)]);
            room.actionsThisRound[playerId] = true;
        } else if (room.phase === "VOTE") {
            room.votes[playerId] = playerId;
            broadcastVotes(roomId);
        }
        nextTurn(roomId);
    }

    function endPhase(roomId) {
        const room = rooms[roomId];
        clearInterval(room.timerInterval);

        if (room.phase === "INTRO") startPhase(roomId, "REVEAL");
        else if (room.phase === "REVEAL") {
            room.actionsThisRound = {}; 
            startPhase(roomId, "DEBATE");
        }
        else if (room.phase === "DEBATE") startPhase(roomId, "VOTE");
        else if (room.phase === "VOTE") processVotes(roomId);
    }

    // --- ДІЇ ГРАВЦІВ ---

    socket.on('reveal_trait', (trait) => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room || room.phase !== "REVEAL") return;
        
        if (socket.id !== room.turnOrder[room.currentTurnIndex]) return; // Не твій хід
        if (room.actionsThisRound[socket.id]) return;

        revealTrait(roomId, socket.id, trait);
        room.actionsThisRound[socket.id] = true;
        socket.emit('action_success');
        
        clearInterval(room.timerInterval);
        nextTurn(roomId);
    });

    socket.on('submit_vote', (targetId) => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room || room.phase !== "VOTE") return;
        
        if (socket.id !== room.turnOrder[room.currentTurnIndex]) return; // Не твій хід
        
        room.votes[socket.id] = targetId;
        broadcastVotes(roomId);
        
        clearInterval(room.timerInterval);
        nextTurn(roomId);
    });

    socket.on('add_time', () => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room) return;
        
        const p = room.players[socket.id];
        const isMyTurn = (room.turnOrder.length > 0 && room.turnOrder[room.currentTurnIndex] === socket.id);
        const isGlobal = (room.turnOrder.length === 0 && room.phase !== "LOBBY");

        if (p && !p.isKicked && p.bonusTimeUsed < 2 && (isMyTurn || isGlobal)) {
            p.bonusTimeUsed++;
            room.timeLeft += 30;
            io.to(roomId).emit('timer_tick', room.timeLeft); // Оновити візуально
            io.to(roomId).emit('new_message', { user: "СИСТЕМА", text: `⏳ ${p.name} додав час!` });
            socket.emit('bonus_used_update', p.bonusTimeUsed);
        }
    });

    // --- ДОПОМІЖНІ ---
    function revealTrait(roomId, playerId, trait) {
        const room = rooms[roomId];
        if (room.playerCharacters[playerId]) {
            io.to(roomId).emit('player_revealed_trait', { 
                playerId, trait, value: room.playerCharacters[playerId][trait] 
            });
        }
    }

    function broadcastVotes(roomId) {
        const room = rooms[roomId];
        let counts = {};
        Object.values(room.votes).forEach(t => counts[t] = (counts[t] || 0) + 1);
        io.to(roomId).emit('vote_update', { 
            counts, 
            needed: Object.values(room.players).filter(p => !p.isKicked).length,
            totalVoted: Object.keys(room.votes).length
        });
    }

    function notifyTurn(roomId) {
        const room = rooms[roomId];
        const id = room.turnOrder[room.currentTurnIndex];
        if(id) io.to(roomId).emit('turn_update', { activePlayerId: id, activeName: room.players[id].name });
    }

    async function processVotes(roomId) {
        const room = rooms[roomId];
        let counts = {};
        Object.values(room.votes).forEach(t => counts[t] = (counts[t] || 0) + 1);
        
        let loserId = null, max = 0;
        for (let [id, c] of Object.entries(counts)) {
            if (c > max) { max = c; loserId = id; }
        }

        if (loserId) {
            room.players[loserId].isKicked = true;
            io.to(roomId).emit('voting_result', { message: `🛑 ВИГНАНО: ${room.players[loserId].name}` });
            io.to(roomId).emit('update_player_list', room.players);
            
            const survivors = Object.values(room.players).filter(p => !p.isKicked).length;
            if (survivors <= room.scenario.places) {
                finishGame(roomId);
            } else {
                room.round++;
                room.votes = {};
                setTimeout(() => startPhase(roomId, "REVEAL"), 5000);
            }
        } else {
            setTimeout(() => startPhase(roomId, "REVEAL"), 3000);
        }
    }

    async function finishGame(roomId) {
        const room = rooms[roomId];
        clearInterval(room.timerInterval);
        io.to(roomId).emit('new_message', { user: "СИСТЕМА", text: "ГЕНЕРАЦІЯ ФІНАЛУ..." });

        let survivors = [];
        for (let id in room.players) {
            if (!room.players[id].isKicked) survivors.push({ ...room.playerCharacters[id], name: room.players[id].name });
        }

        try {
            const prompt = `ГРА БУНКЕР ФІНАЛ. Сценарій: ${JSON.stringify(room.scenario)}. Вижили: ${JSON.stringify(survivors)}. Напиши жорсткий висновок (6 речень) українською. Вижили чи ні?`;
            const result = await model.generateContent(prompt);
            io.to(roomId).emit('game_over', result.response.text());
        } catch (e) {
            io.to(roomId).emit('game_over', "Зв'язок втрачено... Ви вижили.");
        }
    }

    // Тимчасовий SKIP
    socket.on('skip_phase', () => {
        const roomId = socket.data.roomId;
        if(roomId && rooms[roomId]) {
            io.to(roomId).emit('new_message', { user: "ADMIN", text: "⏩ SKIP!" });
            endPhase(roomId);
        }
    });

    socket.on('send_message', (text) => {
        const roomId = socket.data.roomId;
        if(roomId) io.to(roomId).emit('new_message', { user: rooms[roomId].players[socket.id].name, text });
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId]) {
            delete rooms[roomId].players[socket.id];
            io.to(roomId).emit('update_player_list', rooms[roomId].players);
            // Якщо кімната пуста - видалити її (опціонально)
            if (Object.keys(rooms[roomId].players).length === 0) delete rooms[roomId];
        }
    });
});

const PORT = 3000;
server.listen(PORT, () => { console.log(`http://localhost:${PORT}`); });