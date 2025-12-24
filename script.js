const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxCcFc1ZOK1Bb0-8hKNCwDTetO4tntHtZDWRqwNI2fkOWeUxvlyUeknadkly_5kRtXeJw/exec"; 

    // --- 1. LOCAL STORAGE & SYNC SETUP ---
    let db = JSON.parse(localStorage.getItem('tripData')) || {
        itinerary: [], budget: [], settlement: [], checklist: [], transactions: [],
        settlementGrid: [], settlementHeaders: []
    };
    
    let syncQueue = JSON.parse(localStorage.getItem('syncQueue')) || [];
    let curDay = "";
    let chartObj = null;
    let isSyncing = false; 

    // --- 2. SERVICE WORKER ---
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js')
            .catch(err => console.log('SW Fail:', err));
    }

    // --- 3. TOAST UI ---
    function showToast(message, type = "info") {
        const box = document.getElementById("toast-box");
        const el = document.createElement("div");
        el.className = `toast ${type}`;
        
        let icon = "🔔";
        if(type === "success") icon = "☁️";
        if(type === "error") icon = "⚠️";
        if(type === "offline") icon = "🔌";
        
        el.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
        box.appendChild(el);

        setTimeout(() => {
            el.style.animation = "fadeOut 0.5s forwards";
            setTimeout(() => el.remove(), 500);
        }, 3500);
    }

    // --- 4. DATA SYNC LOGIC ---
    function saveDataLocally() {
        localStorage.setItem('tripData', JSON.stringify(db));
        localStorage.setItem('syncQueue', JSON.stringify(syncQueue));
        updateSyncUI(); 
    }

    function updateSyncUI() {
        const el = document.getElementById("syncStatus");
        const statusEl = document.getElementById("appStatus");
        const wasOffline = statusEl.innerText.includes("Offline");

        if (navigator.onLine) {
            statusEl.innerText = "Online";
            statusEl.style.background = "#2a9d8f"; 
            
            if(wasOffline) {
                showToast("Back Online!", "info");
                flushQueue(); 
            }

            if (syncQueue.length > 0) {
                el.innerText = `Syncing ${syncQueue.length} changes...`;
            } else {
                el.innerText = "All data synced";
            }
        } else {
            statusEl.innerText = "Offline Mode";
            statusEl.style.background = "#e63946"; 
            el.innerText = syncQueue.length > 0 ? `${syncQueue.length} changes pending` : "Ready";
        }
    }

    window.addEventListener('online', updateSyncUI);
    window.addEventListener('offline', updateSyncUI);

    async function init() {
        if (db.itinerary.length > 0) {
            if (!curDay) curDay = db.itinerary[0].date;
            renderAll();
        } else {
             document.getElementById("tripSubtitle").innerText = "Loading Local Data...";
        }

        updateSyncUI();

        if(navigator.onLine) {
            try {
                const response = await fetch(SCRIPT_URL);
                const data = await response.json();
                
                if (data.status === "success") {
                    processIncomingData(data);
                    // We run local recalc here too, just to be safe
                    recalculateLocally(); 
                    saveDataLocally();
                    renderAll();
                    console.log("Data refreshed from cloud");
                }
            } catch (e) {
                console.log("Network fetch failed, using local data");
            }
        }
        startTimer();
    }

    function processIncomingData(data) {
        // We still accept the matrix from server, but we will override it with local calc
        // to ensure immediate consistency with local transactions
        let grid = [];
        let headers = [];
        
        if (data.settlementMatrix) {
            headers = data.settlementMatrix.receivers;
            grid = data.settlementMatrix.payers.map(p => {
                const rowObj = { name: p.name };
                p.owes.forEach((val, idx) => {
                    const receiverName = headers[idx];
                    rowObj[receiverName] = val;
                });
                return rowObj;
            });
        }

        db = {
            itinerary: data.itinerary || [],
            budget: data.budget || [],
            checklist: data.packing || [], 
            settlement: data.settlement || [],
            transactions: data.transactions || [],
            settlementGrid: grid,
            settlementHeaders: headers
        };
        
        if (db.itinerary.length > 0 && !curDay) curDay = db.itinerary[0].date;
    }

    // ========================================================
    // ⚡ NEW: CLIENT-SIDE CALCULATION (INSTANT UPDATES)
    // ========================================================
    function recalculateLocally() {
        // 1. Get all participants
        const people = db.settlement.map(s => s.name).filter(n => n);
        const count = people.length;
        if(count === 0) return;

        // 2. Initialize Maps
        let paidMap = {};
        let shareMap = {};
        let matrix = {}; // matrix[payer][consumer] = amount
        
        people.forEach(p => {
            paidMap[p] = 0;
            shareMap[p] = 0;
            matrix[p] = {};
            people.forEach(c => matrix[p][c] = 0);
        });

        // 3. Process All Transactions (Newest + Oldest)
        db.transactions.forEach(t => {
            const amt = parseFloat(t.amount) || 0;
            const payer = t.payer;
            
            // Skip invalid data
            if(!people.includes(payer)) return;

            // Update Payer Total
            paidMap[payer] += amt;

            if (t.type === "Equal" || t.type === true) {
                // Split Equally
                const splitAmt = amt / count;
                people.forEach(consumer => {
                    shareMap[consumer] += splitAmt;
                    if(payer !== consumer) {
                        matrix[payer][consumer] += splitAmt;
                    }
                });
            } else {
                // Individual Split
                const consumer = t.bene === 'All' ? 'ALL' : t.bene; // Handle inconsistencies
                if (people.includes(consumer)) {
                    shareMap[consumer] += amt;
                    if(payer !== consumer) {
                        matrix[payer][consumer] += amt;
                    }
                }
            }
        });

        // 4. Update db.settlement (The summary list)
        db.settlement = people.map(p => {
            const paid = paidMap[p];
            const share = shareMap[p];
            const bal = paid - share;
            let action = "Settled";
            if(bal > 1) action = `Get ₹${Math.round(bal)}`;
            if(bal < -1) action = `Pay ₹${Math.round(Math.abs(bal))}`;
            
            return {
                name: p,
                totalpaid: paid,
                shareOfSharedExpenses: share,
                balance: bal,
                action: action
            };
        });

        // 5. Update db.settlementGrid (The breakdown matrix)
        db.settlementHeaders = people;
        db.settlementGrid = people.map(payer => {
            let row = { name: payer };
            people.forEach(consumer => {
                row[consumer] = matrix[payer][consumer];
            });
            return row;
        });
    }

    function renderAll() {
        renderDashboard();
        renderItinerary();
        renderMoney();
        renderPacking();
    }

    // --- 5. QUEUE SYSTEM ---
    async function gasPost(payload) {
        syncQueue.push(payload);
        saveDataLocally();
        if(navigator.onLine) await flushQueue();
        return true; 
    }

    async function flushQueue() {
        if (syncQueue.length === 0 || !navigator.onLine || isSyncing) return;
        isSyncing = true; 
        const statusEl = document.getElementById("syncStatus");
        
        try {
            while(syncQueue.length > 0 && navigator.onLine) {
                statusEl.innerText = `Syncing ${syncQueue.length}...`;
                const item = syncQueue[0]; 
                await fetch(SCRIPT_URL, { method: 'POST', mode: 'no-cors', body: JSON.stringify(item) });
                syncQueue.shift(); 
                saveDataLocally(); 
            }
            showToast(`Synced updates to Cloud!`, "success");
        } catch (e) {
            showToast("Sync paused.", "error");
        } finally {
            isSyncing = false; 
            updateSyncUI();
        }
    }

    // --- 6. ACTIONS ---
    async function toggleStatus(index, newStatus) {
        db.itinerary[index].status = newStatus;
        renderItinerary();
        renderDashboard();
        saveDataLocally();
        await gasPost({ action: "toggleVisit", index: index, status: newStatus });
    }

    async function syncPack(item, status) {
        const target = db.checklist.find(c => c.item === item);
        if(target) target.packed = status;
        renderPacking();
        renderDashboard();
        saveDataLocally();
        await gasPost({ action: "togglePack", item: item, status: status });
    }

    async function addExpense() {
        const btn = document.getElementById("saveTxBtn");
        const originalText = "Save Transaction";

        try {
            btn.disabled = true;
            btn.innerText = "Saving...";

            const splitType = document.querySelector('input[name="splitType"]:checked').value;
            const desc = document.getElementById("exDesc").value;
            const amount = parseFloat(document.getElementById("exAmount").value);
            const payer = document.getElementById("exPayer").value;
            const cat = document.getElementById("exCategory").value;
            const bene = splitType === 'equal' ? 'ALL' : document.getElementById("exBene").value;

            if(!desc || !amount || payer === "Select..." || (splitType === 'individual' && bene === "Select...")) {
                showToast("Please fill all fields!", "error");
                return; 
            }

            const transactionData = {
                date: document.getElementById("exDate").value || new Date().toISOString().split('T')[0],
                cat: cat, desc: desc, amount: amount, payer: payer,
                isIndividual: splitType === 'individual',
                beneficiary: bene
            };

            // 1. Update Transaction Log
            db.transactions.unshift({
                date: transactionData.date,
                desc: transactionData.desc,
                amount: transactionData.amount,
                payer: transactionData.payer,
                type: transactionData.isIndividual ? "Individual" : "Equal",
                bene: transactionData.beneficiary === 'ALL' ? 'All' : transactionData.beneficiary
            });
            
            // 2. Update Budget
            const budgetItem = db.budget.find(b => b.category === cat);
            if(budgetItem) budgetItem.actual = (parseFloat(budgetItem.actual) || 0) + amount;

            // 3. INSTANT CALCULATION (The Fix)
            recalculateLocally();

            renderMoney();
            renderDashboard();
            
            // 4. Reset Form
            document.getElementById("exDesc").value = "";
            document.getElementById("exAmount").value = "";
            document.getElementById("exPayer").selectedIndex = 0;
            document.getElementById("exCategory").selectedIndex = 0;
            const equalRadio = document.querySelector('input[name="splitType"][value="equal"]');
            if(equalRadio) { equalRadio.checked = true; toggleBene(); }

            gasPost({ action: "addTransaction", data: transactionData });
            
            if(navigator.onLine) showToast("Transaction saved!", "info");
            else showToast("Saved to device!", "offline");

        } catch (error) {
            console.error(error);
            showToast("Error saving transaction", "error");
        } finally {
            btn.disabled = false;
            btn.innerText = originalText;
        }
    }

    // --- HELPER FUNCTIONS ---
    function formatDate(dateInput) {
        if (!dateInput) return "---";
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return String(dateInput);
        return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    }

    function formatTime(timeInput) {
        if (!timeInput) return "---";
        let rawTime = "";
        if (typeof timeInput === 'string' && timeInput.includes("1899")) {
            const parts = timeInput.split(" "); 
            const timePart = parts.find(p => p.includes(":"));
            rawTime = timePart ? timePart.substring(0, 5) : "";
        } else if (timeInput instanceof Date) {
            rawTime = timeInput.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        } else {
            rawTime = String(timeInput);
        }
        if (!rawTime.includes(':')) return rawTime;
        let [h, m] = rawTime.split(':');
        let hours = parseInt(h);
        let minutes = m.substring(0, 2);
        let ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12;
        hours = hours ? hours : 12;
        return `${hours}:${minutes} ${ampm}`;
    }

    function parseTripDate(dateInput, timeInput) {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return null;
        let hours = 0, mins = 0;
        let raw = "";
        if (typeof timeInput === 'string' && timeInput.includes("1899")) {
            const parts = timeInput.split(" ");
            const timePart = parts.find(p => p.includes(":"));
            raw = timePart || "";
        } else if (timeInput instanceof Date) {
            d.setHours(timeInput.getHours(), timeInput.getMinutes(), 0, 0);
            return d.getTime();
        } else {
            raw = String(timeInput);
        }
        if (raw.includes(':')) {
            const parts = raw.split(':');
            hours = parseInt(parts[0]) || 0;
            mins = parseInt(parts[1]) || 0;
        }
        d.setHours(hours, mins, 0, 0);
        return d.getTime();
    }

    function navigateTo(pageId, navIndex) {
        const navItems = document.querySelectorAll('.nav-bar .nav-item');
        if (navItems[navIndex]) {
            switchPage(pageId, navItems[navIndex]);
        }
    }

    function startTimer() {
        if (!db.itinerary || db.itinerary.length === 0) return;
        const timerEl = document.getElementById("timer");
        const emojiEl = document.getElementById("timerEmoji");
        const tripStart = parseTripDate(db.itinerary[0].date, db.itinerary[0].departTime);
        const tripEnd = parseTripDate(db.itinerary[db.itinerary.length - 1].date, "23:59");
        document.getElementById("tripSubtitle").innerText = `${formatDate(db.itinerary[0].date)} - ${formatDate(db.itinerary[db.itinerary.length - 1].date)} | ${db.settlement.length} Friends`;

        setInterval(() => {
            const now = new Date().getTime();
            const todayStr = formatDate(new Date());
            if (now > tripEnd) {
                emojiEl.innerText = "🥳";
                timerEl.innerText = "Trip Completed!";
            } else if (db.itinerary.some(i => formatDate(i.date) === todayStr)) {
                emojiEl.innerText = "🛣️";
                timerEl.innerText = "YOU ARE ON TRIP";
            } else {
                const diff = tripStart - now;
                if (diff < 0) {
                    timerEl.innerText = "Trip Started!";
                } else {
                    const d = Math.floor(diff / (1000 * 60 * 60 * 24));
                    const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                    timerEl.innerText = d > 0 ? `${d}d ${h}h to go` : `${h}h to go`;
                }
            }
        }, 1000);
    }

    function renderDashboard() {
        const itin = db.itinerary;
        const lastTrueIdx = itin.map(i => i.status).lastIndexOf(true);
        const nextIdx = (lastTrueIdx === -1) ? 0 : lastTrueIdx + 1;
        const next = itin[nextIdx] || itin[itin.length - 1];

        if(next) {
            document.getElementById("nextEventTitle").innerText = next.departPlace || "No Events";
            document.getElementById("nextEventMeta").innerText = `${formatDate(next.date)} @ ${formatTime(next.departTime)}`;
        }

        const totalP = db.budget.reduce((a, b) => a + (parseFloat(b.planned) || 0), 0);
        const totalA = db.budget.reduce((a, b) => a + (parseFloat(b.actual) || 0), 0);
        const rem = totalP - totalA;
        const perc = totalP > 0 ? (totalA / totalP) * 100 : 0;

        document.getElementById("dashBudgetRem").innerText = rem.toLocaleString();
        document.getElementById("dashBudgetStatus").innerText = `of ₹${totalP.toLocaleString()} Total`;
        document.getElementById("dashBudgetSpent").innerText = `Spent: ₹${totalA.toLocaleString()}`;
        
        const bar = document.getElementById("dashBudgetBar");
        bar.style.width = Math.min(perc, 100) + "%";
        bar.style.backgroundColor = perc > 90 ? "var(--alert)" : perc > 60 ? "var(--accent)" : "var(--secondary)";

        const meals = ["breakfast", "lunch", "dinner", "snacks"];
        const realPlaces = itin.filter(p => p.departPlace && !meals.some(m => p.departPlace.toLowerCase().includes(m)));
        const visited = realPlaces.filter(p => p.status).length;
        document.getElementById("dashboardPlaceStat").innerText = `${visited}/${realPlaces.length}`;

        const packed = db.checklist.filter(c => c.packed).length;
        document.getElementById("dashboardPackStat").innerText = `${packed}/${db.checklist.length}`;

        const avCon = document.getElementById("avatarContainer");
        avCon.innerHTML = "";
        db.settlement.forEach(s => {
            if (!s.name) return;
            const d = document.createElement("div");
            d.className = "avatar";
            d.innerText = s.name.substring(0,2).toUpperCase();
            d.onclick = () => showProfile(s);
            avCon.appendChild(d);
        });
    }

    function renderItinerary() {
        const uniqueDays = [...new Set(db.itinerary.map(i => i.date))];
        const tabs = document.getElementById("dayTabs");
        tabs.innerHTML = "";
        uniqueDays.forEach(day => {
            const d = document.createElement("div");
            d.className = `day-tab ${curDay === day ? 'active' : ''}`;
            d.innerText = formatDate(day);
            d.onclick = () => { curDay = day; renderItinerary(); };
            tabs.appendChild(d);
        });
        const container = document.getElementById("timelineContainer");
        container.innerHTML = "";
        db.itinerary.filter(i => i.date === curDay).forEach((act) => {
            const fullIdx = db.itinerary.indexOf(act);
            const div = document.createElement("div");
            div.className="activity-card " + (act.status ? "visited" : ""); 
            div.style.marginBottom = "25px";
            div.innerHTML = `
                <div class = "activity-content" style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <div class="activity-time" style="font-size:0.75rem; color:var(--primary); font-weight:800;">${formatTime(act.departTime)}</div>
                        <div class="activity-title" style="font-weight:700; ${act.status ? 'text-decoration:line-through; opacity:0.5;' : ''}">${act.departPlace}</div>
                        ${document.getElementById("driverToggle").checked ? `<div class="card-sub">🅿️ ₹${act.parking} | 🛣️ ₹${act.toll}</div>` : ''}
                    </div>
                    <div style="font-size:1.2rem; cursor:pointer;" onclick="toggleStatus(${fullIdx}, ${!act.status})">${act.status ? '✅' : '⬜'}</div>
                </div>
            `;
            container.appendChild(div);
        });
    }

    function renderMoney() {
        const pSel = document.getElementById("exPayer");
        const bSel = document.getElementById("exBene");
        if(pSel.children.length <= 1) {
            pSel.innerHTML = bSel.innerHTML = "<option disabled selected>Select...</option>";
            db.settlement.forEach(s => {
                if(!s.name) return;
                pSel.innerHTML += `<option value="${s.name}">${s.name}</option>`;
                bSel.innerHTML += `<option value="${s.name}">${s.name}</option>`;
            });
        }
        
        const ctx = document.getElementById("budgetChart").getContext("2d");
        if(chartObj) chartObj.destroy();
        chartObj = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: db.budget.map(b => b.category),
                datasets: [{
                    data: db.budget.map(b => parseFloat(b.actual) || 0),
                    backgroundColor: ['#0077b6','#2a9d8f','#f4a261','#e63946','#86868b','#222']
                }]
            },
            options: { cutout: '75%', plugins: { legend: { display: false } } }
        });
        const spent = db.budget.reduce((a, b) => a + (parseFloat(b.actual) || 0), 0);
        const planned = db.budget.reduce((a, b) => a + (parseFloat(b.planned) || 0), 0);
        document.getElementById("totalSpentText").innerText = `₹${spent.toLocaleString()}`;
        document.getElementById("totalRemText").innerText = `₹${(planned - spent).toLocaleString()}`;
        
        const log = document.getElementById("transactionLogBody");
        log.innerHTML = "";
        db.transactions.slice(0, 50).forEach(t => {
            log.innerHTML += `<tr>
                <td>${formatDate(t.date)}</td><td>${t.desc}</td><td>₹${t.amount}</td>
                <td>${t.payer}</td><td>${t.type}</td><td>${t.bene}</td>
            </tr>`;
        });
    }

    function renderPacking() {
        const con = document.getElementById("packingContainer");
        con.innerHTML = "";
        db.checklist.forEach((c) => {
            const d = document.createElement("div");
            d.className = "card";
            d.style = "display:flex; justify-content:space-between; align-items:center; padding:15px;";
            d.innerHTML = `
                <span style="${c.packed ? 'text-decoration:line-through; opacity:0.5' : ''}">${c.item}</span>
                <input type="checkbox" ${c.packed ? 'checked' : ''} style="width:20px; margin:0;" onchange="syncPack('${c.item}', this.checked)">
            `;
            con.appendChild(d);
        });
        const total = db.checklist.length;
        const packed = db.checklist.filter(x => x.packed).length;
        const perc = total > 0 ? Math.round((packed / total) * 100) : 0;
        document.getElementById("packPerc").innerText = perc + "%";
    }

    function switchPage(id, el) {
        document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
        document.getElementById(id).classList.add("active");
        if(el) {
            document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
            el.classList.add("active");
        }
        if(id === 'money') renderMoney();
        if(id === 'itinerary') renderItinerary();
        if(id === 'packing') renderPacking();
        if(id === 'dashboard') renderDashboard();
    }

    function closeProfileModal() {
        document.getElementById("profileModal").classList.remove('show');
        setTimeout(() => toggleModalView(false), 300); 
    }

    function toggleModalView(showDetail) {
        document.getElementById("modalMainView").style.display = showDetail ? "none" : "block";
        document.getElementById("modalDetailView").style.display = showDetail ? "block" : "none";
    }

    function showProfile(personData) {
        const name = personData.name;
        document.getElementById("modalName").innerText = name;
        document.getElementById("modalAvatar").innerText = name.substring(0,2).toUpperCase();
        
        document.getElementById("modalPaid").innerText = `₹${(parseFloat(personData.totalpaid) || 0).toLocaleString()}`;
        document.getElementById("modalShare").innerText = `₹${(parseFloat(personData.shareOfSharedExpenses) || 0).toLocaleString()}`;
        
        const balanceAction = personData.action || "Settled";
        const bEl = document.getElementById("modalBalance");
        const bText = document.getElementById("balanceText");
        
        bText.innerText = balanceAction;
        
        const isDebt = balanceAction.toLowerCase().includes("pay");
        bEl.style.color = isDebt ? "var(--alert)" : "var(--secondary)";
        bEl.style.background = isDebt ? "rgba(230, 57, 70, 0.1)" : "rgba(42, 157, 143, 0.1)";

        bEl.onclick = () => {
            renderSettlementDetail(name);
            toggleModalView(true);
        };

        document.getElementById("profileModal").classList.add("show");
    }

    function renderSettlementDetail(userName) {
        const listCon = document.getElementById("settlementList");
        listCon.innerHTML = "";
        
        const grid = db.settlementGrid || []; 
        const headers = db.settlementHeaders || [];
        let hasData = false;

        grid.forEach(row => {
            const payerName = row.name;
            if (payerName === userName) {
                headers.forEach(receiverName => {
                    const amount = parseFloat(row[receiverName]) || 0;
                    if (amount > 0 && receiverName !== userName) {
                         hasData = true;
                         addDetailItem(listCon, `Receive from <b>${receiverName}</b>`, `+₹${Math.ceil(amount)}`, "var(--secondary)");
                    }
                });
            } else {
                if (headers.includes(userName)) {
                    const amount = parseFloat(row[userName]) || 0;
                    if (amount > 0) {
                        hasData = true;
                        addDetailItem(listCon, `Pay to <b>${payerName}</b>`, `-₹${Math.ceil(amount)}`, "var(--alert)");
                    }
                }
            }
        });

        if (!hasData) {
            listCon.innerHTML = "<div class='card-sub' style='text-align:center; padding: 20px;'>Everything is clear! 🏖️</div>";
        }
    }

    function addDetailItem(container, textHTML, amountText, color) {
        const item = document.createElement("div");
        item.style.padding = "12px";
        item.style.borderBottom = "1px solid rgba(0,0,0,0.05)";
        item.style.display = "flex";
        item.style.justifyContent = "space-between";
        item.innerHTML = `<span>${textHTML}</span> <span style="color:${color}; font-weight:700;">${amountText}</span>`;
        container.appendChild(item);
    }

    function toggleBene() {
        document.getElementById("beneDiv").style.display = document.querySelector('input[name="splitType"]:checked').value === 'individual' ? 'block' : 'none';
    }

    window.onload = init;