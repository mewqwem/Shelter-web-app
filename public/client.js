const socket = io();

// ЕКРАНИ
const menuScreen = document.getElementById('menu-screen');
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');

// ЕЛЕМЕНТИ МЕНЮ
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomMenuBtn = document.getElementById('joinRoomMenuBtn');
const backToMenuBtn = document.getElementById('backToMenuBtn');
const roomInputContainer = document.getElementById('room-input-container');
const loginTitle = document.getElementById('login-title');

// ЕЛЕМЕНТИ ВХОДУ
const usernameInput = document.getElementById('username');
const roomCodeInput = document.getElementById('room-code-input');
const actionBtn = document.getElementById('actionBtn'); // Кнопка "Увійти"

// ЕЛЕМЕНТИ ГРИ
const playersList = document.getElementById('players-list');
const startBtn = document.getElementById('startBtn');
const scenarioDiv = document.getElementById('scenario-display');
const myCardDiv = document.getElementById('my-card-display');
const phaseDisplay = document.getElementById('phase-display');
const timerDisplay = document.getElementById('timer-display');
const addTimeBtn = document.getElementById('add-time-btn');
const statusPanel = document.getElementById('game-status-panel');
const roomInfoPanel = document.getElementById('room-info-panel');
const roomCodeDisplay = document.getElementById('room-code-display');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const chatMessages = document.getElementById('chat-messages');
const turnInfo = document.getElementById('turn-info'); // Якщо ти його додав в index.html, якщо ні - ігноруй помилку

let myId = null;
let currentMode = null; // 'create' або 'join'
let allPlayersData = {};
let currentPhase = "LOBBY";
let activePlayerId = null;

socket.on('connect', () => { myId = socket.id; });

// --- ЛОГІКА МЕНЮ ---

createRoomBtn.addEventListener('click', () => {
    currentMode = 'create';
    menuScreen.style.display = 'none';
    loginScreen.style.display = 'block';
    roomInputContainer.style.display = 'none';
    loginTitle.textContent = "СТВОРЕННЯ ГРИ";
    actionBtn.textContent = "СТВОРИТИ";
});

joinRoomMenuBtn.addEventListener('click', () => {
    currentMode = 'join';
    menuScreen.style.display = 'none';
    loginScreen.style.display = 'block';
    roomInputContainer.style.display = 'block';
    loginTitle.textContent = "ПРИЄДНАННЯ";
    actionBtn.textContent = "УВІЙТИ";
});

backToMenuBtn.addEventListener('click', () => {
    loginScreen.style.display = 'none';
    menuScreen.style.display = 'block';
});

// --- ЛОГІКА ВХОДУ ---

actionBtn.addEventListener('click', () => {
    const name = usernameInput.value.trim();
    if (!name) { alert("Введіть ім'я!"); return; }

    if (currentMode === 'create') {
        socket.emit('create_room', name);
    } else {
        const code = roomCodeInput.value.trim();
        if (!code) { alert("Введіть код кімнати!"); return; }
        socket.emit('join_room', { roomId: code, nickname: name });
    }
});

// Успішний вхід у кімнату
socket.on('room_joined', (data) => {
    // data = { roomId, isAdmin }
    loginScreen.style.display = 'none';
    gameScreen.style.display = 'block';
    
    // Показуємо код кімнати
    roomInfoPanel.classList.remove('hidden');
    roomCodeDisplay.textContent = data.roomId;
});

socket.on('error_message', (msg) => {
    alert(msg);
});

// --- ДАЛІ СТАНДАРТНИЙ КОД ГРИ ---

socket.on('update_player_list', (playersObj) => {
    allPlayersData = playersObj;
    playersList.innerHTML = Object.entries(playersObj).map(([id, p]) => {
        const style = p.isKicked ? 'text-decoration: line-through; color: red;' : '';
        const adminBadge = p.isAdmin ? '👑' : '';
        return `<li style="${style}">${adminBadge} ${p.name}</li>`;
    }).join('');
    renderTable();
});

socket.on('set_admin', () => { /* Цей івент може не прийти, бо ми передаємо isAdmin в room_joined */ });
// Але ми можемо перевірити роль при вході
socket.on('room_joined', (data) => {
    if(data.isAdmin) {
        startBtn.style.display = 'block';
        if (!document.getElementById('finishBtn')) {
            // Додаємо кнопку скіпа для адміна
            const skipBtn = document.createElement('button');
            skipBtn.textContent = "⏩ SKIP";
            skipBtn.style.background = "cyan";
            skipBtn.style.color="black";
            skipBtn.style.marginTop = "10px";
            skipBtn.onclick = () => socket.emit('skip_phase');
            document.querySelector('.panel-section').appendChild(skipBtn);
        }
    }
});

startBtn.addEventListener('click', () => {
    startBtn.disabled = true;
    socket.emit('start_game_request');
});

socket.on('reset_start_btn', () => startBtn.disabled = false);

socket.on('scenario_update', (data) => {
    const sc = data.scenario;
    statusPanel.style.display = 'flex';
    statusPanel.classList.remove('hidden');
    scenarioDiv.innerHTML = `<div class="scenario-box"><h2>${sc.title}</h2><p>${sc.description}</p><p>Час: ${sc.duration} | Місць: ${sc.places}</p><div id="turn-info" style="background:yellow;color:black;text-align:center;display:none;"></div></div>`;
    startBtn.style.display = 'none';
    currentPhase = "INTRO";
    updateInterfaceForPhase();
});

socket.on('phase_change', (data) => {
    currentPhase = data.phase;
    phaseDisplay.textContent = data.title;
    updateInterfaceForPhase();
    renderTable(); // Очистити голоси візуально
});

socket.on('turn_update', (data) => {
    activePlayerId = data.activePlayerId;
    const info = document.getElementById('turn-info');
    if(info) {
        if(activePlayerId) {
            info.style.display = 'block';
            info.textContent = `ХІД: ${data.activeName}`;
        } else {
            info.style.display = 'none';
        }
    }
    updateInterfaceForPhase();
    renderTable();
});

socket.on('timer_tick', (sec) => {
    const m = Math.floor(sec/60);
    const s = sec%60;
    timerDisplay.textContent = `${m}:${s<10?'0'+s:s}`;
});

socket.on('your_character', (char) => {
    myCardDiv.innerHTML = `
        <div class="player-card" style="width: 100%; border-color: var(--accent-green);">
            <ul class="my-traits">
                <li data-trait="profession" onclick="reveal('profession', this)">🕵️‍♂️ ПРФ: ${char.profession}</li>
                <li data-trait="gender" onclick="reveal('gender', this)">⚧ СТАТЬ: ${char.gender}</li>
                <li data-trait="age" onclick="reveal('age', this)">🎂 ВІК: ${char.age}</li>
                <li data-trait="health" onclick="reveal('health', this)">❤️ ЗДР: ${char.health}</li>
                <li data-trait="hobby" onclick="reveal('hobby', this)">🎨 ХОБІ: ${char.hobby}</li>
                <li data-trait="inventory" onclick="reveal('inventory', this)">🎒 ІНВ: ${char.inventory}</li>
                <li data-trait="trait" onclick="reveal('trait', this)">💡 ФАКТ: ${char.trait}</li>
            </ul>
        </div>
    `;
    updateInterfaceForPhase();
});

window.reveal = (trait, el) => {
    if(el.classList.contains('revealed')) return;
    if(currentPhase !== "REVEAL") return alert("Не час!");
    if(activePlayerId && activePlayerId !== myId) return alert("Не твій хід!");
    if(confirm("Відкрити?")) socket.emit('reveal_trait', trait);
};

socket.on('player_revealed_trait', (data) => {
    const map = { 'profession': 'prof', 'gender': 'gen', 'age': 'age', 'health': 'health', 'inventory': 'inv', 'hobby': 'hobby', 'trait': 'trait' };
    const el = document.getElementById(`${map[data.trait]}-${data.playerId}`);
    if(el) el.innerHTML = `${data.trait}: <span style="color:lime">${data.value}</span>`;
    
    if(data.playerId === myId) {
        const myLi = document.querySelector(`.my-traits li[data-trait="${data.trait}"]`);
        if(myLi) {
            myLi.classList.add('revealed');
            myLi.style.color = "lime";
            myLi.style.borderColor = "lime";
        }
    }
});

// Функція рендеру столу (скорочена, встав свій повний код з попередньої версії)
function renderTable() {
    const tableDiv = document.getElementById('players-table');
    for (const [id, p] of Object.entries(allPlayersData)) {
        let card = document.getElementById(`card-${id}`);
        if (!card && !p.isKicked) {
            card = document.createElement('div');
            card.id = `card-${id}`;
            card.className = "player-card";
            // Встав сюди HTML картки з попереднього client.js
            // Обов'язково додай data-ids для полів (prof-${id} і т.д.)
            card.innerHTML = `<strong>${p.name}</strong>
            <div id="stats-${id}">
             <p id="prof-${id}">PRF: ░░░</p>
             <p id="gen-${id}">GEN: ░░░</p>
             <p id="age-${id}">AGE: ░░░</p>
             <p id="health-${id}">HLT: ░░░</p>
             <p id="inv-${id}">INV: ░░░</p>
             <p id="hobby-${id}">HOB: ░░░</p>
             <p id="trait-${id}">TRT: ░░░</p>
            </div>
            <div class="vote-counter"><div class="vote-bar-fill" id="votebar-${id}"></div></div>`;
            
            if (id !== myId) card.innerHTML += `<button class="vote-btn-card" onclick="voteFor('${id}')">⚠ TARGET</button>`;
            
            tableDiv.appendChild(card);
        }
        
        // Підсвітка активного гравця
        if(card && !p.isKicked) {
            if(id === activePlayerId) card.style.border = "2px solid yellow";
            else card.style.border = "1px solid #333";
        }
        
        if (p.isKicked && card) {
            card.style.opacity = 0.5;
            card.style.border = "1px solid red";
        }
    }
    updateInterfaceForPhase();
}

function updateInterfaceForPhase() {
    // Встав сюди логіку блокування кнопок з попереднього client.js
    const isMyTurn = (myId === activePlayerId);
    document.querySelectorAll('.vote-btn-card').forEach(btn => {
        if(currentPhase === "VOTE") {
            btn.style.display = "block";
            btn.disabled = !isMyTurn;
        } else btn.style.display = "none";
    });
}

window.voteFor = (target) => {
    if(confirm("Голосувати?")) socket.emit('submit_vote', target);
};

socket.on('vote_update', (data) => {
    if(data.totalVoted === 0) { /* Очистити смужки */ document.querySelectorAll('.vote-bar-fill').forEach(b => b.style.width = '0%'); return; }
    for(const [id, count] of Object.entries(data.counts)) {
        const bar = document.getElementById(`votebar-${id}`);
        if(bar) bar.style.width = `${(count/data.needed)*100}%`;
    }
});

socket.on('voting_result', (res) => alert(res.message));
socket.on('game_over', (story) => {
    gameScreen.innerHTML = `<div style="padding:20px;"><h1>КІНЕЦЬ</h1><p>${story}</p><button onclick="location.reload()">НОВА ГРА</button></div>`;
});

// Чат
window.addTime = () => socket.emit('add_time');
socket.on('bonus_used_update', (n) => addTimeBtn.innerText = `+30s (${2-n})`);

sendChatBtn.onclick = () => {
    const txt = chatInput.value;
    if(txt) { socket.emit('send_message', txt); chatInput.value = ""; }
};
socket.on('new_message', (d) => {
    const div = document.createElement('div');
    div.innerHTML = `<b>${d.user}:</b> ${d.text}`;
    chatMessages.appendChild(div);
});