const socket = io();

// ЕЛЕМЕНТИ
const menuScreen = document.getElementById('menu-screen');
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomMenuBtn = document.getElementById('joinRoomMenuBtn');
const backToMenuBtn = document.getElementById('backToMenuBtn');
const roomInputContainer = document.getElementById('room-input-container');
const loginTitle = document.getElementById('login-title');
const usernameInput = document.getElementById('username');
const roomCodeInput = document.getElementById('room-code-input');
const actionBtn = document.getElementById('actionBtn');
const roomInfoPanel = document.getElementById('room-info-panel');
const roomCodeDisplay = document.getElementById('room-code-display');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const statusPanel = document.getElementById('game-status-panel');
const phaseDisplay = document.getElementById('phase-display');
const timerDisplay = document.getElementById('timer-display');
const addTimeBtn = document.getElementById('add-time-btn');
const startBtn = document.getElementById('startBtn');
const scenarioDiv = document.getElementById('scenario-display');
const myCardDiv = document.getElementById('my-card-display');
const chatHeader = document.getElementById('chat-header');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const chatMessages = document.getElementById('chat-messages');

let myId = null;
let currentMode = null; 
let allPlayersData = {};
let currentPhase = "LOBBY";
let activePlayerId = null;
let revealedCache = {}; // Пам'ять відкритих карт

socket.on('connect', () => { 
    myId = socket.id; 
    const savedRoom = localStorage.getItem('bunker_room');
    const savedName = localStorage.getItem('bunker_name');
    if (savedRoom && savedName) {
        socket.emit('join_room', { roomId: savedRoom, nickname: savedName });
    }
});

// МЕНЮ
createRoomBtn.onclick = () => { currentMode = 'create'; menuScreen.style.display = 'none'; loginScreen.style.display = 'block'; roomInputContainer.style.display = 'none'; loginTitle.textContent = "СТВОРЕННЯ ГРИ"; actionBtn.textContent = "СТВОРИТИ"; };
joinRoomMenuBtn.onclick = () => { currentMode = 'join'; menuScreen.style.display = 'none'; loginScreen.style.display = 'block'; roomInputContainer.style.display = 'block'; loginTitle.textContent = "ПРИЄДНАННЯ"; actionBtn.textContent = "УВІЙТИ"; };
backToMenuBtn.onclick = () => { loginScreen.style.display = 'none'; menuScreen.style.display = 'block'; };

actionBtn.onclick = () => {
    const name = usernameInput.value.trim();
    if (!name) { alert("Введіть ім'я!"); return; }
    localStorage.setItem('bunker_name', name);

    if (currentMode === 'create') socket.emit('create_room', name);
    else {
        const code = roomCodeInput.value.trim();
        if (!code) { alert("Введіть код кімнати!"); return; }
        socket.emit('join_room', { roomId: code, nickname: name });
    }
};

// ВХІД
socket.on('room_joined', (data) => {
    localStorage.setItem('bunker_room', data.roomId);
    loginScreen.style.display = 'none';
    menuScreen.style.display = 'none';
    gameScreen.style.display = 'block';
    
    roomInfoPanel.classList.remove('hidden');
    roomCodeDisplay.textContent = data.roomId;
    document.getElementById('leaveRoomBtn').style.display = 'block';
    
    chatHeader.textContent = `💬 КАНАЛ КІМНАТИ [${data.roomId}]`;
    chatMessages.innerHTML = ''; 

    if(data.isAdmin) {
        startBtn.style.display = 'block';
        if (!document.getElementById('skipBtn')) {
            const skipBtn = document.createElement('button');
            skipBtn.textContent = "⏩ SKIP";
            skipBtn.style.background = "cyan";
            skipBtn.style.color = "black";
            skipBtn.style.marginTop = "10px";
            skipBtn.onclick = () => socket.emit('skip_phase');
            document.querySelector('.panel-section').appendChild(skipBtn);
        }
    }
});

socket.on('error_message', (msg) => {
    alert(msg);
    if (msg.includes("не існує")) { localStorage.removeItem('bunker_room'); location.reload(); }
});

leaveRoomBtn.onclick = () => {
    if(confirm("Вийти? Ви станете дезертиром.")) {
        socket.emit('leave_room');
        localStorage.removeItem('bunker_room');
        location.reload();
    }
};

// ГРА
socket.on('update_player_list', (playersObj) => {
    allPlayersData = playersObj;
    renderTable();
    updateInterfaceForPhase();
});

startBtn.onclick = () => { 
    startBtn.disabled = true; 
    startBtn.textContent = "ЗАВАНТАЖЕННЯ..."; 
    revealedCache = {}; // Чистимо кеш для нової гри
    socket.emit('start_game_request'); 
};

socket.on('reset_start_btn', () => { startBtn.disabled = false; startBtn.textContent = "ЗАПУСТИТИ СИМУЛЯЦІЮ"; });

socket.on('scenario_update', (data) => {
    const sc = data.scenario;
    statusPanel.style.display = 'flex';
    statusPanel.classList.remove('hidden');
    scenarioDiv.innerHTML = `<div class="scenario-box"><h2>${sc.title}</h2><p>${sc.description}</p><p>Час: ${sc.duration} | Місць: ${sc.places}</p><div id="turn-info" style="background:yellow;color:black;text-align:center;display:none;"></div></div>`;
    startBtn.style.display = 'none';
    currentPhase = "INTRO";
    revealedCache = {}; 
    updateInterfaceForPhase();
});

socket.on('phase_change', (data) => {
    currentPhase = data.phase;
    phaseDisplay.textContent = data.title;
    document.querySelectorAll('.vote-bar-fill').forEach(b => b.style.width = '0%');
    document.querySelectorAll('.vote-number').forEach(n => { n.textContent='0'; n.style.display='none'; });
    updateInterfaceForPhase();
    renderTable();
});

socket.on('turn_update', (data) => {
    activePlayerId = data.activePlayerId;
    const info = document.getElementById('turn-info');
    if(info) {
        if(activePlayerId) {
            info.style.display = 'block';
            info.textContent = `▶ ХІД ГРАВЦЯ: ${data.activeName ? data.activeName.toUpperCase() : '...'}`;
            if(activePlayerId === myId) document.title = "!!! ТВІЙ ХІД !!!"; else document.title = "BUNKER";
        } else { info.style.display = 'none'; document.title = "BUNKER"; }
    }
    updateInterfaceForPhase();
    renderTable();
});

socket.on('timer_tick', (sec) => {
    const m = Math.floor(sec/60);
    const s = sec%60;
    timerDisplay.textContent = `${m}:${s<10?'0'+s:s}`;
    timerDisplay.style.color = (sec <= 10) ? 'red' : 'var(--accent-green)';
});

window.addTime = () => socket.emit('add_time');
socket.on('bonus_used_update', (n) => {
    addTimeBtn.innerText = `+30s (${2-n})`;
    updateInterfaceForPhase();
});

// МОЯ КАРТКА (Без actions)
socket.on('your_character', (char) => {
    if (!revealedCache[myId]) revealedCache[myId] = {};
    Object.assign(revealedCache[myId], char);

    let html = `<div class="player-card" style="width: 100%; border-color: var(--accent-green);"><ul class="my-traits">`;
    const traits = [
        {k:'profession', l:'🕵️‍♂️ ПРФ'}, {k:'gender', l:'⚧ СТАТЬ'}, {k:'age', l:'🎂 ВІК'},
        {k:'health', l:'❤️ ЗДР'}, {k:'hobby', l:'🎨 ХОБІ'}, {k:'inventory', l:'🎒 ІНВ'},
        {k:'trait', l:'💡 ФАКТ'}
    ];
    traits.forEach(t => {
        html += `<li data-trait="${t.k}" onclick="reveal('${t.k}', this)">${t.l}: ${char[t.k]}</li>`;
    });
    html += `</ul></div>`;
    myCardDiv.innerHTML = html;
    updateInterfaceForPhase();
});

window.reveal = (trait, el) => {
    if(el.classList.contains('revealed')) return;
    if(currentPhase !== "REVEAL") return alert("Не час!");
    if(activePlayerId && activePlayerId !== myId) return alert("Не твій хід!");
    
    if(confirm("Відкрити?")) socket.emit('reveal_trait', trait);
};

socket.on('player_revealed_trait', (data) => {
    if (!revealedCache[data.playerId]) revealedCache[data.playerId] = {};
    revealedCache[data.playerId][data.trait] = data.value;

    const map = { 'profession': 'prof', 'gender': 'gen', 'age': 'age', 'health': 'health', 'inventory': 'inv', 'hobby': 'hobby', 'trait': 'trait' };
    const el = document.getElementById(`${map[data.trait]}-${data.playerId}`);
    if(el) el.innerHTML = `${data.trait.toUpperCase()}: <span style="color:lime">${data.value}</span>`;
    
    if(data.playerId === myId) {
        const myLi = document.querySelector(`.my-traits li[data-trait="${data.trait}"]`);
        if(myLi) {
            myLi.classList.add('revealed');
            myLi.style.color = "lime";
            myLi.style.borderColor = "lime";
        }
    }
});

function renderTable() {
    const tableDiv = document.getElementById('players-table');
    tableDiv.innerHTML = "";

    for (const [id, p] of Object.entries(allPlayersData)) {
        let card = document.createElement('div');
        card.id = `card-${id}`;
        card.className = "player-card";
        
        const crown = p.isAdmin ? "👑" : "";
        const status = p.online ? "🟢" : "🔴";
        
        if (p.isKicked) {
            card.innerHTML = `<div style="text-align:center; color:red; padding:20px;"><h1>☠</h1><h3>${p.name}</h3><p>ELIMINATED</p></div>`;
            card.style.opacity = 0.5;
            card.style.border = "1px solid red";
        } else {
            const cache = revealedCache[id] || {};
            const val = (key) => cache[key] ? `<span style="color:lime">${cache[key]}</span>` : '░░░';

            let htmlContent = `
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #333; padding-bottom:5px; margin-bottom:5px;">
                <strong>${crown} ${p.name} <span style="font-size:10px">${status}</span></strong>
                <span class="vote-number" id="votenumm-${id}" style="display:none;">0</span>
            </div>
            <div id="stats-${id}">
             <p id="prof-${id}">PRF: ${val('profession')}</p>
             <p id="gen-${id}">GEN: ${val('gender')}</p>
             <p id="age-${id}">AGE: ${val('age')}</p>
             <p id="health-${id}">HLT: ${val('health')}</p>
             <p id="inv-${id}">INV: ${val('inventory')}</p>
             <p id="hobby-${id}">HOB: ${val('hobby')}</p>
             <p id="trait-${id}">TRT: ${val('trait')}</p>
            </div>
            <div class="vote-counter"><div class="vote-bar-fill" id="votebar-${id}"></div></div>`;
            
            if (id !== myId) htmlContent += `<button class="vote-btn-card" onclick="voteFor('${id}')">⚠ TARGET</button>`;
            else htmlContent += `<div style="text-align:center;font-size:10px;margin-top:5px;">ЦЕ ТИ</div>`;
            
            card.innerHTML = htmlContent;
            if(id === activePlayerId) card.style.border = "2px solid yellow";
        }
        tableDiv.appendChild(card);
    }
    updateInterfaceForPhase();
}

function updateInterfaceForPhase() {
    const isMyTurn = (myId === activePlayerId);
    document.querySelectorAll('.vote-btn-card').forEach(btn => {
        if(currentPhase === "VOTE") {
            btn.style.display = "block";
            btn.disabled = !isMyTurn;
        } else btn.style.display = "none";
    });

    addTimeBtn.style.display = 'none';
    if (currentPhase !== "LOBBY") {
        const myData = allPlayersData[myId];
        if (myData && myData.bonusTimeUsed < 2) {
            addTimeBtn.style.display = 'block';
        }
    }
    
    if (revealedCache[myId]) {
        for (const [trait, val] of Object.entries(revealedCache[myId])) {
            const myLi = document.querySelector(`.my-traits li[data-trait="${trait}"]`);
            if(myLi) {
                myLi.classList.add('revealed');
                myLi.style.color = "lime";
                myLi.style.borderColor = "lime";
            }
        }
    }
}

window.voteFor = (target) => {
    if(confirm("Голосувати?")) socket.emit('submit_vote', target);
};

socket.on('vote_update', (data) => {
    if(data.totalVoted === 0) { document.querySelectorAll('.vote-bar-fill').forEach(b => b.style.width = '0%'); return; }
    for(const [id, count] of Object.entries(data.counts)) {
        const bar = document.getElementById(`votebar-${id}`);
        const num = document.getElementById(`votenumm-${id}`);
        if(bar) bar.style.width = `${(count/data.needed)*100}%`;
        if(num) { num.textContent = count; num.style.display = count > 0 ? 'block' : 'none'; }
    }
});

socket.on('voting_result', (res) => alert(res.message));
socket.on('game_over', (story) => {
    gameScreen.innerHTML = `<div style="padding:20px;"><h1>КІНЕЦЬ</h1><p style="border:1px solid white;padding:10px;">${story}</p><button onclick="location.reload()">НОВА ГРА</button></div>`;
});

sendChatBtn.onclick = () => {
    const txt = chatInput.value.trim();
    if(txt) { socket.emit('send_message', txt); chatInput.value = ""; }
};
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatBtn.click(); });

socket.on('new_message', (d) => {
    const div = document.createElement('div');
    if(d.user === "СИСТЕМА" || d.user === "ADMIN") div.className = "sys-msg";
    else div.className = "msg";
    div.innerHTML = `<b>${d.user}:</b> ${d.text}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});

document.getElementById('chat-header').onclick = () => {
    const body = document.getElementById('chat-body');
    body.style.display = (body.style.display === 'none') ? 'flex' : 'none';
};