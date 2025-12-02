const socket = io();

// === ЕЛЕМЕНТИ ІНТЕРФЕЙСУ ===
// Екрани
const menuScreen = document.getElementById('menu-screen');
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');

// Меню
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomMenuBtn = document.getElementById('joinRoomMenuBtn');
const backToMenuBtn = document.getElementById('backToMenuBtn');
const roomInputContainer = document.getElementById('room-input-container');
const loginTitle = document.getElementById('login-title');

// Вхід
const usernameInput = document.getElementById('username');
const roomCodeInput = document.getElementById('room-code-input');
const actionBtn = document.getElementById('actionBtn');

// Гра (Шапка)
const roomInfoPanel = document.getElementById('room-info-panel');
const roomCodeDisplay = document.getElementById('room-code-display');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const statusPanel = document.getElementById('game-status-panel');
const phaseDisplay = document.getElementById('phase-display');
const timerDisplay = document.getElementById('timer-display');
const addTimeBtn = document.getElementById('add-time-btn');

// Гра (Основне)
const playersList = document.getElementById('players-list');
const startBtn = document.getElementById('startBtn');
const scenarioDiv = document.getElementById('scenario-display');
const myCardDiv = document.getElementById('my-card-display');
const turnInfo = document.getElementById('turn-info'); // (Створюється динамічно, якщо немає в HTML)

// Чат
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const chatMessages = document.getElementById('chat-messages');

// === ЗМІННІ СТАНУ ===
let myId = null;
let currentMode = null; // 'create' або 'join'
let allPlayersData = {};
let currentPhase = "LOBBY";
let activePlayerId = null;

socket.on('connect', () => { myId = socket.id; });

// ==========================================
// 1. ЛОГІКА МЕНЮ ТА ВХОДУ
// ==========================================

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

// Успішний вхід
socket.on('room_joined', (data) => {
    loginScreen.style.display = 'none';
    gameScreen.style.display = 'block';
    
    // Показуємо панель кімнати
    roomInfoPanel.classList.remove('hidden');
    roomCodeDisplay.textContent = data.roomId;
    
    // Ховаємо кнопку часу на старті
    addTimeBtn.style.display = 'none';

    // Якщо я адмін
    if(data.isAdmin) {
        startBtn.style.display = 'block';
        // Додаємо кнопку SKIP (DEV TOOL)
        if (!document.getElementById('skipBtn')) {
            const skipBtn = document.createElement('button');
            skipBtn.id = 'skipBtn';
            skipBtn.textContent = "⏩ SKIP PHASE";
            skipBtn.style.background = "cyan";
            skipBtn.style.color = "black";
            skipBtn.style.marginTop = "10px";
            skipBtn.style.fontWeight = "bold";
            skipBtn.onclick = () => socket.emit('skip_phase');
            
            const panel = document.querySelector('.panel-section');
            if(panel) panel.appendChild(skipBtn);
        }
    }
});

socket.on('error_message', (msg) => alert(msg));

// ЛОГІКА ВИХОДУ
leaveRoomBtn.addEventListener('click', () => {
    if (confirm("Вийти з кімнати?")) {
        socket.emit('leave_room');
        location.reload(); // Перезавантаження для повного очищення
    }
});


// ==========================================
// 2. ІГРОВИЙ ПРОЦЕС
// ==========================================

// Оновлення списку гравців
socket.on('update_player_list', (playersObj) => {
    allPlayersData = playersObj;
    playersList.innerHTML = Object.entries(playersObj).map(([id, p]) => {
        const style = p.isKicked ? 'text-decoration: line-through; color: red;' : '';
        const adminBadge = p.isAdmin ? '👑' : '';
        return `<li style="${style}">${adminBadge} ${p.name}</li>`;
    }).join('');
    
    renderTable(); // Оновити стіл
    updateInterfaceForPhase(); // Оновити кнопки (наприклад, якщо змінилися бонуси часу)
});

// Старт гри
startBtn.addEventListener('click', () => {
    startBtn.disabled = true;
    startBtn.textContent = "ЗАВАНТАЖЕННЯ...";
    socket.emit('start_game_request');
});

socket.on('reset_start_btn', () => {
    startBtn.disabled = false;
    startBtn.textContent = "ЗАПУСТИТИ СИМУЛЯЦІЮ";
});

// Отримання сценарію
socket.on('scenario_update', (data) => {
    const sc = data.scenario;
    statusPanel.style.display = 'flex';
    statusPanel.classList.remove('hidden');
    
    scenarioDiv.innerHTML = `
        <div class="scenario-box">
            <h2>⚠ УВАГА: ${sc.title}</h2>
            <p>${sc.description}</p>
            <div style="display:flex; justify-content:space-between; margin-top:10px; font-weight:bold; color:var(--accent-green);">
                <span>⏱ Час: ${sc.duration}</span>
                <span>🚪 Місць: ${sc.places}</span>
            </div>
            <div id="turn-info" style="margin-top:10px; padding:5px; background:var(--accent-yellow); color:black; font-weight:bold; text-align:center; display:none;"></div>
        </div>
    `;
    
    startBtn.style.display = 'none';
    currentPhase = "INTRO";
    
    // Очищаємо голоси візуально на старті
    document.querySelectorAll('.vote-bar-fill').forEach(b => b.style.width = '0%');
    document.querySelectorAll('.vote-number').forEach(n => { n.textContent='0'; n.style.display='none'; });

    updateInterfaceForPhase();
});

// Зміна фази
socket.on('phase_change', (data) => {
    currentPhase = data.phase;
    phaseDisplay.textContent = data.title;
    
    // Очищаємо голоси візуально
    document.querySelectorAll('.vote-bar-fill').forEach(b => b.style.width = '0%');
    document.querySelectorAll('.vote-number').forEach(n => { n.textContent='0'; n.style.display='none'; });

    updateInterfaceForPhase();
    renderTable();
});

// Зміна ходу (Активний гравець)
socket.on('turn_update', (data) => {
    activePlayerId = data.activePlayerId;
    const info = document.getElementById('turn-info');
    
    if (info) {
        if (activePlayerId) {
            info.style.display = 'block';
            info.textContent = `▶ ХІД ГРАВЦЯ: ${data.activeName ? data.activeName.toUpperCase() : '...'}`;
            
            if (activePlayerId === myId) document.title = "!!! ТВІЙ ХІД !!!";
            else document.title = "BUNKER";
        } else {
            info.style.display = 'none';
            document.title = "BUNKER";
        }
    }
    updateInterfaceForPhase();
    renderTable(); // Оновити підсвічування картки на столі
});

// Таймер
socket.on('timer_tick', (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    timerDisplay.textContent = `${m}:${s < 10 ? '0' + s : s}`;
    timerDisplay.style.color = (sec <= 10) ? 'red' : 'var(--accent-green)';
});

// Бонусний час
window.addTime = () => socket.emit('add_time');
socket.on('bonus_used_update', (n) => {
    addTimeBtn.innerText = `+30s (${2 - n})`;
    updateInterfaceForPhase();
});

// ==========================================
// 3. КАРТКИ ТА ВЗАЄМОДІЯ
// ==========================================

// Моя картка
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

// Логіка кліку по моїй картці
window.reveal = (trait, el) => {
    if (el.classList.contains('revealed')) return;
    if (currentPhase !== "REVEAL") return alert("Зараз не час відкривати карти!");
    if (activePlayerId && activePlayerId !== myId) return alert("Зачекай своєї черги!");
    
    if (confirm(`Відкрити: ${trait}?`)) {
        socket.emit('reveal_trait', trait);
    }
};

// Коли хтось відкрив картку (приходить від сервера)
socket.on('player_revealed_trait', (data) => {
    const map = { 'profession': 'prof', 'gender': 'gen', 'age': 'age', 'health': 'health', 'inventory': 'inv', 'hobby': 'hobby', 'trait': 'trait' };
    const el = document.getElementById(`${map[data.trait]}-${data.playerId}`);
    
    // Оновлюємо на столі
    if (el) el.innerHTML = `${data.trait.toUpperCase()}: <span style="color:lime">${data.value}</span>`;
    
    // Якщо це я - оновлюємо мою картку (робимо зеленою)
    if (data.playerId === myId) {
        const myLi = document.querySelector(`.my-traits li[data-trait="${data.trait}"]`);
        if (myLi) {
            myLi.classList.add('revealed');
            myLi.style.color = "lime";
            myLi.style.borderColor = "lime";
            myLi.onclick = null;
        }
    }
});

// Рендер столу (всі гравці)
function renderTable() {
    const tableDiv = document.getElementById('players-table');
    for (const [id, p] of Object.entries(allPlayersData)) {
        let card = document.getElementById(`card-${id}`);
        
        // Створюємо картку, якщо немає
        if (!card && !p.isKicked) {
            card = document.createElement('div');
            card.id = `card-${id}`;
            card.className = "player-card";
            card.innerHTML = `
            <div style="display:flex; justify-content:space-between;">
                <strong>${p.name}</strong>
                <span class="vote-number" id="votenumm-${id}" style="display:none;">0</span>
            </div>
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
            else card.innerHTML += `<div style="text-align:center;font-size:10px;margin-top:5px;">ЦЕ ТИ</div>`;
            
            tableDiv.appendChild(card);
        }
        
        // Оновлюємо стан (активний гравець / вигнаний)
        if (card && !p.isKicked) {
            if (id === activePlayerId) {
                card.style.border = "2px solid var(--accent-yellow)";
                card.style.boxShadow = "0 0 15px rgba(255, 204, 0, 0.3)";
                card.style.transform = "scale(1.02)";
            } else {
                card.style.border = "1px solid #333";
                card.style.boxShadow = "none";
                card.style.transform = "scale(1)";
            }
        }
        
        if (p.isKicked && card) {
            card.innerHTML = `<div style="text-align:center; color:red; padding:20px;"><h1>☠</h1><h3>${p.name}</h3><p>ELIMINATED</p></div>`;
            card.style.opacity = 0.5;
            card.style.border = "1px solid red";
        }
    }
    updateInterfaceForPhase();
}

// === ГОЛОВНА ФУНКЦІЯ СТАНУ ІНТЕРФЕЙСУ ===
function updateInterfaceForPhase() {
    const isMyTurn = (myId === activePlayerId);
    
    // 1. Кнопки голосування
    document.querySelectorAll('.vote-btn-card').forEach(btn => {
        if (currentPhase === "VOTE") {
            btn.style.display = "block";
            btn.disabled = !isMyTurn;
            btn.textContent = isMyTurn ? "⚠ TARGET (ТВІЙ ХІД)" : "ОЧІКУВАННЯ...";
            btn.style.borderColor = isMyTurn ? "var(--accent-red)" : "#333";
            btn.style.color = isMyTurn ? "var(--accent-red)" : "#555";
        } else {
            btn.style.display = "none";
        }
    });

    // 2. Мої картки (блокування)
    document.querySelectorAll('.my-traits li').forEach(li => {
        if (li.classList.contains('revealed')) return;
        
        if (currentPhase === "REVEAL") {
            if (isMyTurn) {
                li.style.cursor = "pointer";
                li.style.opacity = "1";
                li.style.borderColor = "var(--accent-green)";
            } else {
                li.style.cursor = "not-allowed";
                li.style.opacity = "0.5";
                li.style.borderColor = "#333";
            }
        } else {
            li.style.cursor = "not-allowed";
            li.style.opacity = "0.5";
            li.style.borderColor = "#222";
        }
    });

    // 3. Кнопка +30s
    addTimeBtn.style.display = 'none'; // Ховаємо за замовчуванням
    
    // Перевіряємо бонуси
    const myData = allPlayersData[myId];
    const bonusesLeft = myData ? (2 - myData.bonusTimeUsed) : 0;

    if (bonusesLeft > 0) {
        // Показуємо в Дебатах
        if (currentPhase === "DEBATE") {
            addTimeBtn.style.display = 'block';
        } 
        // Або в фазах дій, якщо мій хід
        else if ((currentPhase === "REVEAL" || currentPhase === "VOTE") && isMyTurn) {
            addTimeBtn.style.display = 'block';
        }
    }
}

// Голосування
window.voteFor = (target) => {
    if (confirm("Підтвердити ліквідацію?")) {
        socket.emit('submit_vote', target);
        // Локально блокуємо
        document.querySelectorAll('.vote-btn-card').forEach(b => b.disabled = true);
    }
};

// Оновлення смужок голосування
socket.on('vote_update', (data) => {
    if (data.totalVoted === 0) {
        document.querySelectorAll('.vote-bar-fill').forEach(b => b.style.width = '0%');
        return;
    }
    for (const [id, count] of Object.entries(data.counts)) {
        const bar = document.getElementById(`votebar-${id}`);
        const num = document.getElementById(`votenumm-${id}`);
        if (bar) bar.style.width = `${(count / data.needed) * 100}%`;
        if (num) { 
            num.textContent = count; 
            num.style.display = count > 0 ? 'block' : 'none'; 
        }
    }
});

socket.on('voting_result', (res) => alert(res.message));

// Фінал
socket.on('game_over', (story) => {
    gameScreen.innerHTML = `
        <div style="padding:20px; text-align:center;">
            <h1 style="color:var(--accent-yellow)">КІНЕЦЬ СИМУЛЯЦІЇ</h1>
            <div style="text-align:left; line-height:1.6; border:1px solid white; padding:20px; background:#111; margin-bottom:20px;">
                ${story.replace(/\n/g, '<br>')}
            </div>
            <button onclick="location.reload()" style="padding:15px 30px; font-size:18px;">НОВА ГРА</button>
        </div>
    `;
});

// Чат
sendChatBtn.onclick = () => {
    const txt = chatInput.value.trim();
    if (txt) { socket.emit('send_message', txt); chatInput.value = ""; }
};
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatBtn.click(); });

socket.on('new_message', (d) => {
    const div = document.createElement('div');
    if (d.user === "СИСТЕМА" || d.user === "ADMIN") div.className = "sys-msg";
    else div.className = "msg";
    
    div.innerHTML = `<b>${d.user}:</b> ${d.text}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

// Відкриття/закриття чату
document.getElementById('chat-header').onclick = () => {
    const body = document.getElementById('chat-body');
    body.style.display = (body.style.display === 'none') ? 'flex' : 'none';
};