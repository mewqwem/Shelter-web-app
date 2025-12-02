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

const rooms = {};
const TIMES = { INTRO: 120, DEBATE: 180, TURN: 30 };

function generateRoomCode() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
    socket.join('global'); 

    socket.on('create_room', (nickname) => {
        const roomId = generateRoomCode();
        rooms[roomId] = {
            id: roomId,
            players: {},
            playerCharacters: {},
            votes: {},
            actionsThisRound: {},
            revealedTraits: {}, // Історія відкриттів
            scenario: null,
            phase: "LOBBY",
            round: 0,
            timeLeft: 0,
            timerInterval: null,
            turnOrder: [],
            currentTurnIndex: 0
        };
        joinRoom(socket, roomId, nickname, true);
    });

    socket.on('join_room', ({ roomId, nickname }) => {
        roomId = roomId.toUpperCase();
        if (!rooms[roomId]) { socket.emit('error_message', "❌ Кімнати не існує!"); return; }
        
        const room = rooms[roomId];
        let oldSocketId = null;
        for (let [id, p] of Object.entries(room.players)) {
            if (p.name === nickname) { oldSocketId = id; break; }
        }

        if (oldSocketId) {
            // Reconnect
            room.players[socket.id] = { ...room.players[oldSocketId], online: true };
            if (oldSocketId !== socket.id) delete room.players[oldSocketId];
            
            if (room.playerCharacters[oldSocketId]) {
                room.playerCharacters[socket.id] = room.playerCharacters[oldSocketId];
                if (oldSocketId !== socket.id) delete room.playerCharacters[oldSocketId];
            }
            
            // Переносимо історію відкритих карт
            if (room.revealedTraits[oldSocketId]) {
                room.revealedTraits[socket.id] = room.revealedTraits[oldSocketId];
                if (oldSocketId !== socket.id) delete room.revealedTraits[oldSocketId];
            }

            const tIdx = room.turnOrder.indexOf(oldSocketId);
            if (tIdx !== -1) room.turnOrder[tIdx] = socket.id;

            joinRoom(socket, roomId, nickname, room.players[socket.id].isAdmin, true);
        } else {
            if (room.phase !== "LOBBY") { socket.emit('error_message', "Гра йде!"); return; }
            for (let p of Object.values(room.players)) if (p.name === nickname) { socket.emit('error_message', "Ім'я зайняте!"); return; }
            joinRoom(socket, roomId, nickname, false);
        }
    });

    function joinRoom(socket, roomId, nickname, isAdmin, isReconnect = false) {
        const room = rooms[roomId];
        if (!isReconnect) {
            room.players[socket.id] = { name: nickname, isKicked: false, bonusTimeUsed: 0, isAdmin: isAdmin, online: true };
            room.revealedTraits[socket.id] = [];
        }
        socket.leave('global');
        socket.join(roomId);
        socket.data.roomId = roomId;
        socket.data.nickname = nickname;
        
        socket.emit('room_joined', { roomId: roomId, isAdmin: room.players[socket.id].isAdmin });
        io.to(roomId).emit('update_player_list', room.players);
        
        if (!isReconnect) io.to(roomId).emit('new_message', { user: "СИСТЕМА", text: `${nickname} зайшов.` });
        else io.to(roomId).emit('new_message', { user: "СИСТЕМА", text: `${nickname} повернувся.` });

        if (room.phase !== "LOBBY") {
            socket.emit('scenario_update', { scenario: room.scenario, round: room.round });
            if (room.playerCharacters[socket.id]) socket.emit('your_character', room.playerCharacters[socket.id]);
            
            // ВІДНОВЛЮЄМО СТІЛ ДЛЯ РЕКОННЕКТУ
            for (let pid in room.revealedTraits) {
                const traits = room.revealedTraits[pid];
                if (traits) {
                    traits.forEach(trait => {
                        socket.emit('player_revealed_trait', { 
                            playerId: pid, 
                            trait, 
                            value: room.playerCharacters[pid][trait] 
                        });
                    });
                }
            }

            socket.emit('phase_change', { phase: room.phase, title: room.phase, time: room.timeLeft });
            if (room.turnOrder.length > 0) notifyTurn(roomId);
        }
    }

    socket.on('start_game_request', async () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms[roomId]) return;
        const room = rooms[roomId];
        
        // Для тесту 2 гравці
        if (Object.keys(room.players).length < 2) { 
             socket.emit('error_message', "Мало гравців!"); 
             socket.emit('reset_start_btn'); return;
        }

        clearInterval(room.timerInterval);
        room.round = 1; room.votes = {}; room.actionsThisRound = {}; room.revealedTraits = {};
        for(let id in room.players) { 
            room.players[id].isKicked = false; 
            room.players[id].bonusTimeUsed = 0;
            room.revealedTraits[id] = [];
        }

        try {
            const prompt = `Згенеруй гру "Бункер" (JSON) для ${Object.keys(room.players).length} гравців. Структура: { "scenario": { "title": "...", "description": "...", "places": 2, "duration": "..." }, "players": [ { "profession": "...", "health": "...", "gender": "...", "age": "...", "hobby": "...", "inventory": "...", "trait": "...", "action": "...", "type": "HEAL/NONE" } ] }`;
            const result = await model.generateContent(prompt);
            let text = result.response.text();
            const cleanJson = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
            const gameData = JSON.parse(cleanJson);

            room.scenario = gameData.scenario;
            io.to(roomId).emit('scenario_update', { scenario: room.scenario, round: room.round });

            const socketIds = Object.keys(room.players);
            room.playerCharacters = {}; 
            gameData.players.forEach((char, i) => {
                if (socketIds[i]) {
                    room.playerCharacters[socketIds[i]] = char;
                    io.to(socketIds[i]).emit('your_character', char);
                    setTimeout(() => { 
                        revealTrait(roomId, socketIds[i], 'gender'); 
                        revealTrait(roomId, socketIds[i], 'age'); 
                    }, 1000);
                }
            });
            startPhase(roomId, "INTRO");
        } catch (e) { socket.emit('error_message', "AI Error"); socket.emit('reset_start_btn'); }
    });

    socket.on('use_ability', ({ trait, targetName }) => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room || room.phase !== "REVEAL") return;
        if (socket.id !== room.turnOrder[room.currentTurnIndex]) return;
        if (room.actionsThisRound[socket.id]) return;

        const myChar = room.playerCharacters[socket.id];
        if (trait === 'action' && myChar.type === 'HEAL' && targetName) {
            let targetId = Object.keys(room.players).find(k => room.players[k].name === targetName);
            if (targetId && targetId !== socket.id) {
                room.playerCharacters[targetId].health = "Ідеально здоровий (Вилікуваний)";
                revealTrait(roomId, targetId, 'health'); // Відкрити лікування всім
                
                myChar.action = `ВИКОРИСТАНО: Лікування ${targetName}`;
                myChar.type = "USED";
                revealTrait(roomId, socket.id, 'action'); // Показати, що юзнув
            } else { socket.emit('error_message', "Ціль не знайдено!"); return; }
        } else {
            revealTrait(roomId, socket.id, trait);
        }
        room.actionsThisRound[socket.id] = true;
        socket.emit('action_success');
        clearInterval(room.timerInterval);
        nextTurn(roomId);
    });

    function revealTrait(roomId, pid, trait) {
        const room = rooms[roomId];
        if(room.playerCharacters[pid]) {
            if (!room.revealedTraits[pid]) room.revealedTraits[pid] = [];
            if (!room.revealedTraits[pid].includes(trait)) room.revealedTraits[pid].push(trait);
            
            io.to(roomId).emit('player_revealed_trait', { 
                playerId: pid, trait, value: room.playerCharacters[pid][trait] 
            });
        }
    }

    socket.on('submit_vote', (targetId) => {
        const roomId = socket.data.roomId;
        const room = rooms[roomId];
        if (!room || room.phase !== "VOTE") return;
        if (socket.id !== room.turnOrder[room.currentTurnIndex]) return;
        room.votes[socket.id] = targetId;
        broadcastVotes(roomId);
        clearInterval(room.timerInterval);
        nextTurn(roomId);
    });

    socket.on('add_time', () => {
        const roomId = socket.data.roomId;
        if(roomId && rooms[roomId]) {
            const p = rooms[roomId].players[socket.id];
            if(p && !p.isKicked && p.bonusTimeUsed < 2 && rooms[roomId].phase !== "LOBBY") {
                p.bonusTimeUsed++;
                rooms[roomId].timeLeft += 30;
                io.to(roomId).emit('timer_tick', rooms[roomId].timeLeft);
                socket.emit('bonus_used_update', p.bonusTimeUsed);
            }
        }
    });

    socket.on('leave_room', () => {
        const roomId = socket.data.roomId;
        if (roomId && rooms[roomId]) {
            rooms[roomId].players[socket.id].isKicked = true;
            rooms[roomId].players[socket.id].online = false;
            io.to(roomId).emit('update_player_list', rooms[roomId].players);
            io.to(roomId).emit('new_message', { user: "СИСТЕМА", text: `🚪 ${rooms[roomId].players[socket.id].name} втік.` });
            socket.leave(roomId);
            socket.join('global');
            socket.data.roomId = null;
        }
    });

    socket.on('disconnect', () => {
        const roomId = socket.data.roomId;
        if(roomId && rooms[roomId]) {
            if(rooms[roomId].phase === "LOBBY") delete rooms[roomId].players[socket.id];
            else rooms[roomId].players[socket.id].online = false;
            io.to(roomId).emit('update_player_list', rooms[roomId].players);
        }
    });

    socket.on('send_message', (text) => {
        const roomId = socket.data.roomId;
        if(roomId) io.to(roomId).emit('new_message', { user: socket.data.nickname, text });
        else io.to('global').emit('new_message', { user: `[GLOBAL] ${socket.data.nickname || 'Anon'}`, text });
    });

    socket.on('skip_phase', () => {
        const roomId = socket.data.roomId;
        if(roomId && rooms[roomId]) {
            io.to(roomId).emit('new_message', { user: "ADMIN", text: "⏩ SKIP!" });
            endPhase(roomId);
        }
    });

    function startPhase(roomId, phase) {
        const room = rooms[roomId];
        room.phase = phase; room.turnOrder = []; clearInterval(room.timerInterval);
        
        if(phase === "INTRO" || phase === "DEBATE") {
            room.timeLeft = TIMES[phase];
            io.to(roomId).emit('phase_change', { phase, title: phase, time: room.timeLeft });
            io.to(roomId).emit('turn_update', { activePlayerId: null });
            room.timerInterval = setInterval(() => {
                room.timeLeft--;
                io.to(roomId).emit('timer_tick', room.timeLeft);
                if(room.timeLeft <= 0) endPhase(roomId);
            }, 1000);
        } else {
            io.to(roomId).emit('phase_change', { phase, title: phase, time: TIMES.TURN });
            room.turnOrder = Object.keys(room.players).filter(id => !room.players[id].isKicked);
            room.currentTurnIndex = -1;
            nextTurn(roomId);
        }
    }

    function nextTurn(roomId) {
        const room = rooms[roomId];
        room.currentTurnIndex++;
        if(room.currentTurnIndex >= room.turnOrder.length) {
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
            if(room.timeLeft <= 0) {
                clearInterval(room.timerInterval);
                if(room.phase==="REVEAL") {
                    revealTrait(roomId, activeId, ['profession','health','hobby'][Math.floor(Math.random()*3)]);
                    room.actionsThisRound[activeId] = true;
                } else if (room.phase==="VOTE") {
                    room.votes[activeId] = activeId;
                    broadcastVotes(roomId);
                }
                nextTurn(roomId);
            }
        }, 1000);
    }

    function endPhase(roomId) {
        const room = rooms[roomId];
        if(room.phase === "INTRO") startPhase(roomId, "REVEAL");
        else if(room.phase === "REVEAL") { room.actionsThisRound={}; startPhase(roomId, "DEBATE"); }
        else if(room.phase === "DEBATE") startPhase(roomId, "VOTE");
        else if(room.phase === "VOTE") processVotes(roomId);
    }

    async function processVotes(roomId) {
        const room = rooms[roomId];
        let counts = {};
        Object.values(room.votes).forEach(t => counts[t] = (counts[t] || 0) + 1);
        let loserId = null, max = 0;
        for (let [id, c] of Object.entries(counts)) { if (c > max) { max = c; loserId = id; } }

        if (loserId) {
            room.players[loserId].isKicked = true;
            io.to(roomId).emit('voting_result', { message: `🛑 ВИГНАНО: ${room.players[loserId].name}` });
            io.to(roomId).emit('update_player_list', room.players);
            const survivors = Object.values(room.players).filter(p => !p.isKicked).length;
            if (survivors <= room.scenario.places) finishGame(roomId);
            else {
                room.round++; room.votes = {};
                setTimeout(() => startPhase(roomId, "REVEAL"), 5000);
            }
        } else setTimeout(() => startPhase(roomId, "REVEAL"), 3000);
    }

    async function finishGame(roomId) {
        const room = rooms[roomId];
        clearInterval(room.timerInterval);
        io.to(roomId).emit('new_message', { user: "СИСТЕМА", text: "ГЕНЕРАЦІЯ ФІНАЛУ..." });
        let survivors = [];
        for (let id in room.players) if (!room.players[id].isKicked) survivors.push({ ...room.playerCharacters[id], name: room.players[id].name });
        try {
            const result = await model.generateContent(`ФІНАЛ. Сценарій: ${JSON.stringify(room.scenario)}. Вижили: ${JSON.stringify(survivors)}. Напиши історію.`);
            io.to(roomId).emit('game_over', result.response.text());
        } catch(e) { io.to(roomId).emit('game_over', "Кінець."); }
    }
    
    function broadcastVotes(roomId) {
        const room = rooms[roomId];
        let counts = {};
        Object.values(room.votes).forEach(t => counts[t] = (counts[t] || 0) + 1);
        io.to(roomId).emit('vote_update', { counts, needed: Object.values(room.players).filter(p => !p.isKicked).length, totalVoted: Object.keys(room.votes).length });
    }
    
    function notifyTurn(roomId) {
        const room = rooms[roomId];
        const id = room.turnOrder[room.currentTurnIndex];
        if(id) io.to(roomId).emit('turn_update', { activePlayerId: id, activeName: room.players[id].name });
    }
});

const PORT = 3000;
server.listen(PORT, () => { console.log(`http://localhost:${PORT}`); });