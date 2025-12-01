const socket = io();

// === ЕЛЕМЕНТИ ===
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');
const usernameInput = document.getElementById('username');
const joinBtn = document.getElementById('joinBtn');
const playersList = document.getElementById('players-list');
const startBtn = document.getElementById('startBtn');
const scenarioDiv = document.getElementById('scenario-display');
const myCardDiv = document.getElementById('my-card-display');
const phaseDisplay = document.getElementById('phase-display');
const timerDisplay = document.getElementById('timer-display');
const addTimeBtn = document.getElementById('add-time-btn');
const statusPanel = document.getElementById('game-status-panel');
const chatInput = document.getElementById('chat-input');
const sendChatBtn = document.getElementById('send-chat-btn');
const chatMessages = document.getElementById('chat-messages');

let myId = null;
let allPlayersData = {};
let currentPhase = "LOBBY";
let activePlayerId = null; 

// 1. ВХІД
joinBtn.addEventListener('click', () => {
    const name = usernameInput.value;
    if (name) {
        socket.emit('join_game', name);
        loginScreen.style.display = 'none';
        gameScreen.style.display = 'block';
    }
});

socket.on('connect', () => { myId = socket.id; });

socket.on('update_player_list', (playersObj) => {
    allPlayersData = playersObj;
    playersList.innerHTML = Object.entries(playersObj).map(([id, p]) => {
        const style = p.isKicked ? 'text-decoration: line-through; color: red;' : '';
        return `<li style="${style}">${p.name}</li>`;
    }).join('');
    renderTable();
});

socket.on('set_admin', () => {
    startBtn.style.display = 'block';

    // 1. Кнопка фіналу (якщо ще немає)
    if (!document.getElementById('finishBtn')) {
        const finishBtn = document.createElement('button');
        finishBtn.id = "finishBtn";
        finishBtn.textContent = "☢️ ЗАЧИНИТИ БУНКЕР";
        finishBtn.style.marginTop = "10px";
        finishBtn.style.background = "#9900ff";
        finishBtn.style.color = "white";
        finishBtn.addEventListener('click', () => { if(confirm("Завершити гру?")) socket.emit('generate_ending'); });
        
        const panel = document.querySelector('.panel-section');
        if(panel) panel.appendChild(finishBtn);
    }

    // 2. Кнопка SKIP (ТІЛЬКИ ДЛЯ ТЕСТІВ) - НОВЕ
    if (!document.getElementById('skipBtn')) {
        const skipBtn = document.createElement('button');
        skipBtn.id = "skipBtn";
        skipBtn.textContent = "⏩ SKIP PHASE (DEV)";
        skipBtn.style.marginTop = "10px";
        skipBtn.style.background = "cyan";
        skipBtn.style.color = "black";
        skipBtn.style.fontWeight = "bold";
        
        skipBtn.addEventListener('click', () => {
            socket.emit('skip_phase');
        });
        
        const panel = document.querySelector('.panel-section');
        if(panel) panel.appendChild(skipBtn);
    }
});

startBtn.addEventListener('click', () => {
    startBtn.textContent = "ЗАВАНТАЖЕННЯ...";
    startBtn.disabled = true;
    socket.emit('start_game_request');
});

socket.on('reset_start_btn', () => {
    startBtn.textContent = "ЗАПУСТИТИ СИМУЛЯЦІЮ";
    startBtn.disabled = false;
});

// 2. ГРА
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
    clearVoteVisuals(); // Очищаємо голоси на старті
    updateInterfaceForPhase();
});

socket.on('phase_change', (data) => {
    currentPhase = data.phase;
    phaseDisplay.textContent = data.title;
    timerDisplay.style.color = "var(--accent-green)";
    
    // Якщо почалась нова фаза - очищаємо старі голоси (візуально)
    clearVoteVisuals();

    if (currentPhase === "VOTE") timerDisplay.style.color = "var(--accent-red)";
    updateInterfaceForPhase();
    renderTable();
});

socket.on('turn_update', (data) => {
    activePlayerId = data.activePlayerId;
    const turnInfo = document.getElementById('turn-info');
    if (activePlayerId && turnInfo) {
        turnInfo.textContent = `▶ ХІД ГРАВЦЯ: ${data.activeName ? data.activeName.toUpperCase() : '...'}`;
        turnInfo.style.display = 'block';
        if (activePlayerId === myId) document.title = "!!! ТВІЙ ХІД !!!";
        else document.title = "BUNKER";
    } else if (turnInfo) {
        turnInfo.style.display = 'none';
    }
    updateInterfaceForPhase();
    renderTable();
});

socket.on('timer_tick', (seconds) => {
    const min = Math.floor(seconds / 60);
    const sec = seconds % 60;
    timerDisplay.textContent = `${min < 10 ? '0'+min : min}:${sec < 10 ? '0'+sec : sec}`;
    if (seconds <= 10) timerDisplay.style.color = "red";
});

socket.on('bonus_used_update', (usedCount) => {
    const left = 2 - usedCount;
    addTimeBtn.textContent = `+30s (${left})`;
    if (left <= 0) addTimeBtn.disabled = true;
});

window.addTime = () => socket.emit('add_time');

// 3. МОЯ КАРТКА
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

window.reveal = (trait, element) => {
    if (element.classList.contains('revealed')) return; 
    if (currentPhase !== "REVEAL") { alert("Зараз не час відкривати карти!"); return; }
    if (activePlayerId && activePlayerId !== myId) { alert("Зачекай своєї черги!"); return; }
    
    if (confirm(`Відкрити: ${trait}?`)) socket.emit('reveal_trait', trait);
};

socket.on('action_success', () => {});
socket.on('error_message', (msg) => alert(msg));

// 4. СТІЛ
function renderTable() {
    const tableDiv = document.getElementById('players-table');
    for (const [id, p] of Object.entries(allPlayersData)) {
        let card = document.getElementById(`card-${id}`);
        if (!card && !p.isKicked) {
            card = document.createElement('div');
            card.id = `card-${id}`;
            card.className = "player-card";
            
            let htmlContent = `
                <div style="display:flex; justify-content:space-between;">
                    <strong>${p.name}</strong>
                    <span class="vote-number" id="votenumm-${id}" style="display:none;">0</span>
                </div>
                <div id="stats-${id}">
                    <p id="prof-${id}">ПРФ: <span>░░░░░</span></p>
                    <p id="gen-${id}">СТАТЬ: <span>░░░░░</span></p>
                    <p id="age-${id}">ВІК: <span>░░░░░</span></p>
                    <p id="health-${id}">ЗДР: <span>░░░░░</span></p>
                    <p id="inv-${id}">ІНВ: <span>░░░░░</span></p>
                    <p id="hobby-${id}">ХОБІ: <span>░░░░░</span></p>
                    <p id="trait-${id}">ФАКТ: <span>░░░░░</span></p>
                </div>
                <div class="vote-counter"><div class="vote-bar-fill" id="votebar-${id}" style="width: 0%"></div></div>
            `;
            if (id !== myId) htmlContent += `<button class="vote-btn-card" id="btn-vote-${id}" onclick="voteFor('${id}')">⚠ TARGET</button>`;
            else htmlContent += `<div style="text-align:center; color:#444; margin-top:10px; font-size:10px;">ЦЕ ТИ</div>`;
            
            card.innerHTML = htmlContent;
            tableDiv.appendChild(card);
        }
        
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
            card.style.opacity = "0.5";
            card.style.border = "1px solid red";
        }
    }
    updateInterfaceForPhase();
}

// === НОВА ФУНКЦІЯ: ОЧИЩЕННЯ ВІЗУАЛУ ГОЛОСІВ ===
function clearVoteVisuals() {
    // Знаходимо всі смужки і скидаємо ширину
    const bars = document.querySelectorAll('.vote-bar-fill');
    bars.forEach(bar => bar.style.width = '0%');

    // Знаходимо всі цифри і ховаємо
    const nums = document.querySelectorAll('.vote-number');
    nums.forEach(num => {
        num.textContent = '0';
        num.style.display = 'none';
    });
}

function updateInterfaceForPhase() {
    const isMyTurn = (myId === activePlayerId);
    const voteBtns = document.querySelectorAll('.vote-btn-card');
    voteBtns.forEach(btn => {
        if (currentPhase === "VOTE") {
            btn.style.display = "block";
            if (isMyTurn) {
                btn.disabled = false;
                btn.textContent = "⚠ TARGET (ТВІЙ ХІД)";
                btn.style.borderColor = "var(--accent-red)";
                btn.style.color = "var(--accent-red)";
            } else {
                btn.disabled = true;
                btn.textContent = "ОЧІКУВАННЯ...";
                btn.style.borderColor = "#333";
                btn.style.color = "#555";
            }
        } else {
            btn.style.display = "none";
        }
    });

    const myTraits = document.querySelectorAll('.my-traits li');
    myTraits.forEach(li => {
        if (li.classList.contains('revealed')) return;
        if (currentPhase === "REVEAL") {
            if (isMyTurn) {
                li.style.cursor = "pointer";
                li.style.opacity = "1";
                li.style.borderColor = "var(--accent-green)";
                li.style.boxShadow = "0 0 10px rgba(0, 255, 65, 0.2)";
            } else {
                li.style.cursor = "not-allowed";
                li.style.opacity = "0.4";
                li.style.borderColor = "#333";
                li.style.boxShadow = "none";
            }
        } else {
            li.style.cursor = "not-allowed";
            li.style.opacity = "0.4";
            li.style.borderColor = "#222";
            li.style.boxShadow = "none";
        }
    });
}

window.voteFor = (targetId) => {
    if (confirm("Підтвердити ліквідацію?")) socket.emit('submit_vote', targetId);
};

socket.on('player_revealed_trait', (data) => {
    const map = { 'profession': 'prof', 'gender': 'gen', 'age': 'age', 'health': 'health', 'inventory': 'inv', 'hobby': 'hobby', 'trait': 'trait' };
    const prefix = map[data.trait];
    const element = document.getElementById(`${prefix}-${data.playerId}`);
    
    if (element) {
        element.innerHTML = `${data.trait.toUpperCase()}: <span style="color: var(--accent-green);">${data.value}</span>`;
    }

    if (data.playerId === myId) {
        const myLi = document.querySelector(`.my-traits li[data-trait="${data.trait}"]`);
        if (myLi) {
            myLi.classList.add('revealed');
            myLi.style.color = "var(--accent-green)";
            myLi.style.borderColor = "var(--accent-green)";
            myLi.onclick = null;
        }
    }
});

socket.on('vote_update', (data) => {
    // Спочатку очищаємо, якщо раптом дані прийшли пусті (скидання)
    if (data.totalVoted === 0) {
        clearVoteVisuals();
        return;
    }

    for (const [playerId, count] of Object.entries(data.counts)) {
        const bar = document.getElementById(`votebar-${playerId}`);
        const num = document.getElementById(`votenumm-${playerId}`);
        if (bar && num) {
            const percentage = (count / data.needed) * 100;
            bar.style.width = `${percentage}%`;
            num.textContent = count > 0 ? `⚠ ${count}` : "";
            num.style.display = count > 0 ? 'block' : 'none';
        }
    }
});

socket.on('voting_result', (res) => {
    alert(res.message);
    clearVoteVisuals(); // Очищаємо голоси після вироку
});

function sendMessage() {
    const text = chatInput.value.trim();
    if (text) { socket.emit('send_message', text); chatInput.value = ""; }
}
sendChatBtn.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
socket.on('new_message', (data) => {
    const msgDiv = document.createElement('div');
    if (data.user === "СИСТЕМА") {
        msgDiv.className = "sys-msg";
        msgDiv.textContent = data.text;
    } else {
        msgDiv.className = "msg";
        msgDiv.innerHTML = `<strong>${data.user}:</strong> ${data.text}`;
    }
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
});
socket.on('game_over', (story) => {
    gameScreen.innerHTML = `<div style="text-align:center; margin-top:50px;"><h1 style="color:var(--accent-yellow)">ГРУ ЗАВЕРШЕНО</h1><div style="background:#111; padding:20px; border:1px solid white; text-align:left; line-height:1.6;">${story.replace(/\n/g, '<br>')}</div><button onclick="location.reload()" style="margin-top:20px;">ПЕРЕЗАВАНТАЖИТИ</button></div>`;
});
document.getElementById('chat-header').onclick = () => {
    const body = document.getElementById('chat-body');
    body.style.display = body.style.display === 'none' ? 'flex' : 'none';
};