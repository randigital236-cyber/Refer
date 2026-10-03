/* ============================================================
   RND REWARDS — WITHDRAW MODULE
   Firebase Auth + Realtime Database
   Rules:
   - Withdraw ONLY from releaseWallet
   - Fixed amount: 5 RND
   - Cooldown: 30 days between withdrawals
   - Global unique address check
   - Real-time sync with dashboard's releaseWallet
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getDatabase, ref, get, update, push, set, onValue
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

/* ---------- FIREBASE CONFIG ---------- */
const firebaseConfig = {
    apiKey: "AIzaSyARtuToUfDsK6EOrqpJ6nBpfSHx2JobWhQ",
    authDomain: "randigital-e7715.firebaseapp.com",
    databaseURL: "https://randigital-e7715-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "randigital-e7715",
    storageBucket: "randigital-e7715.firebasestorage.app",
    messagingSenderId: "218883279353",
    appId: "1:218883279353:web:cda990aa068f8fdf4d1528",
    measurementId: "G-1V0QQCQQNZ"
};

/* ---------- CONSTANTS ---------- */
const WITHDRAW_AMOUNT = 5;
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
const MIN_RELEASE_BALANCE = 5;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* ---------- STATE ---------- */
let currentUser = null;
let userData = null;
let unsubUser = null;
let globalUsedAddresses = new Set();
let userWithdrawals = [];
let isProcessing = false;
let tickTimer = null;

/* ============================================================
   HELPERS
   ============================================================ */
const roundTo = (n, dp = 8) =>
    Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

const formatRND = (n, dp = 2) =>
    (Number(n) || 0).toLocaleString(undefined, {
        minimumFractionDigits: dp,
        maximumFractionDigits: dp
    });

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showToast(message, type = 'warning') {
    const existingToast = document.querySelector('.toast-message');
    if (existingToast) existingToast.remove();

    const toast = document.createElement('div');
    toast.className = `toast-message toast-${type}`;
    const title = type === 'success' ? '✅ Success!'
                : type === 'error' ? '❌ Error!'
                : '⚠️ Notice';
    toast.innerHTML = `
        <span class="toast-close" onclick="this.parentElement.remove();">&times;</span>
        <div class="toast-title">${title}</div>
        <div class="toast-desc">${message}</div>`;
    document.body.appendChild(toast);
    setTimeout(() => { if (toast) toast.remove(); }, 8000);
}

/* ============================================================
   GET RELEASE WALLET
   ============================================================ */
function getReleaseWallet() {
    return Number(userData?.releaseWallet) || 0;
}

/* ============================================================
   GET LAST WITHDRAWAL TIME
   ============================================================ */
function getLastWithdrawalTime() {
    if (!userWithdrawals || userWithdrawals.length === 0) return 0;
    // Most recent withdrawal
    const latest = userWithdrawals.reduce((max, w) => {
        const t = new Date(w.date).getTime();
        return t > max ? t : max;
    }, 0);
    return latest;
}

/* ============================================================
   COOLDOWN CHECK
   ============================================================ */
function getCooldownStatus() {
    const lastTime = getLastWithdrawalTime();
    if (lastTime === 0) {
        return { canWithdraw: true, remainingMs: 0 };
    }
    const nextEligible = lastTime + COOLDOWN_MS;
    const remainingMs = nextEligible - Date.now();
    return {
        canWithdraw: remainingMs <= 0,
        remainingMs: Math.max(0, remainingMs),
        nextEligibleAt: nextEligible
    };
}

function formatCooldown(ms) {
    if (ms <= 0) return '0';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}D ${String(h).padStart(2,'0')}H ${String(m).padStart(2,'0')}M`;
    return `${String(h).padStart(2,'0')}H ${String(m).padStart(2,'0')}M ${String(sec).padStart(2,'0')}S`;
}

/* ============================================================
   UPDATE COOLDOWN UI
   ============================================================ */
function updateCooldownUI() {
    const status = getCooldownStatus();
    const cooldownBox = document.getElementById('cooldownBox');
    const cooldownTime = document.getElementById('cooldownTime');

    if (status.canWithdraw) {
        cooldownBox.style.display = 'none';
    } else {
        cooldownBox.style.display = 'flex';
        cooldownTime.textContent = formatCooldown(status.remainingMs);
    }

    // Update button state
    updateButtonState();
}

/* ============================================================
   BUTTON STATE
   ============================================================ */
function updateButtonState() {
    const btn = document.getElementById('withdrawBtn');
    const msgDiv = document.getElementById('message');
    if (!btn) return;

    if (isProcessing) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        return;
    }

    const releaseBal = getReleaseWallet();
    const cooldown = getCooldownStatus();
    const address = document.getElementById('address').value.trim();
    const addressValid = address && address.startsWith('0x') && address.length === 42
                         && !globalUsedAddresses.has(address.toLowerCase());

    let canWithdraw = true;
    let reason = '';

    if (releaseBal < MIN_RELEASE_BALANCE) {
        canWithdraw = false;
        reason = `Insufficient release balance. Need at least ${MIN_RELEASE_BALANCE} RND.`;
    } else if (!cooldown.canWithdraw) {
        canWithdraw = false;
        reason = `Cooldown active. Next withdrawal in ${formatCooldown(cooldown.remainingMs)}.`;
    } else if (!addressValid) {
        canWithdraw = false;
        reason = 'Please enter a valid BEP-20 wallet address.';
    }

    btn.disabled = !canWithdraw;

    if (!canWithdraw) {
        btn.innerHTML = `<i class="fas fa-lock"></i> ${reason.length > 40 ? reason.slice(0, 40) + '...' : reason}`;
    } else {
        btn.innerHTML = `<i class="fas fa-paper-plane"></i> Request Withdrawal (${WITHDRAW_AMOUNT} RND)`;
    }
}

/* ============================================================
   ADDRESS CHECK
   ============================================================ */
window.checkAddress = function(address) {
    const hint = document.getElementById('addressHint');
    const normalized = address.toLowerCase().trim();

    if (!address || address.length < 10) {
        hint.innerHTML = '<i class="fas fa-info-circle"></i> Enter your valid BEP-20 (BNB Chain) wallet address';
        hint.className = 'address-hint';
        updateButtonState();
        return false;
    }

    if (!address.startsWith('0x') || address.length !== 42) {
        hint.innerHTML = '<i class="fas fa-exclamation-triangle"></i> ⚠️ Invalid BEP20 address format. Must start with 0x and be 42 characters.';
        hint.className = 'address-hint error';
        updateButtonState();
        return false;
    }

    if (globalUsedAddresses.has(normalized)) {
        hint.innerHTML = '<i class="fas fa-times-circle"></i> ❌ This wallet address has already been used! Each address can be used only once globally.';
        hint.className = 'address-hint error';
        updateButtonState();
        return false;
    }

    hint.innerHTML = '<i class="fas fa-check-circle"></i> ✅ This address is available for withdrawal.';
    hint.className = 'address-hint success';
    updateButtonState();
    return true;
};

/* ============================================================
   LOAD GLOBAL USED ADDRESSES
   ============================================================ */
async function loadGlobalAddresses() {
    globalUsedAddresses = new Set();
    try {
        const withdrawalsRef = ref(db, 'withdrawals');
        const snapshot = await get(withdrawalsRef);
        snapshot.forEach((childSnap) => {
            const data = childSnap.val();
            if (data.walletAddress) {
                globalUsedAddresses.add(data.walletAddress.toLowerCase().trim());
            }
        });
    } catch (e) {
        console.warn('Could not load global addresses:', e);
    }
}

/* ============================================================
   LOAD USER WITHDRAWALS
   ============================================================ */
async function loadUserWithdrawals() {
    userWithdrawals = [];
    try {
        const withdrawalsRef = ref(db, 'withdrawals');
        const snapshot = await get(withdrawalsRef);
        snapshot.forEach((childSnap) => {
            const data = childSnap.val();
            if (data.uid === currentUser.uid) {
                userWithdrawals.push({ id: childSnap.key, ...data });
            }
        });
        userWithdrawals.sort((a, b) =>
            new Date(b.date).getTime() - new Date(a.date).getTime());
        displayWithdrawalStatus(userWithdrawals);
    } catch (e) {
        console.warn('Could not load user withdrawals:', e);
    }
}

/* ============================================================
   DISPLAY WITHDRAWAL STATUS
   ============================================================ */
function displayWithdrawalStatus(withdrawals) {
    const container = document.getElementById('withdrawalStatusList');
    if (!container) return;

    if (withdrawals.length === 0) {
        container.innerHTML = '<div class="no-withdrawal"><i class="fas fa-clock"></i> No withdrawal requests yet</div>';
        return;
    }

    container.innerHTML = '';
    withdrawals.forEach((wd) => {
        let statusClass = 'status-pending';
        let statusText = '⏳ Pending';
        if (wd.status === 'completed') {
            statusClass = 'status-completed';
            statusText = '✅ Completed';
        } else if (wd.status === 'rejected') {
            statusClass = 'status-rejected';
            statusText = '❌ Rejected';
        }

        let html = `
            <div class="status-item">
                <div class="status-header">
                    <div>
                        <span class="status-amount">${wd.amount} RND</span>
                        <div class="status-date">
                            <i class="far fa-calendar-alt"></i>
                            ${new Date(wd.date).toLocaleString('hi-IN')}
                        </div>
                    </div>
                    <span class="status-badge ${statusClass}">${statusText}</span>
                </div>`;

        if (wd.walletAddress) {
            html += `<div class="status-address"><i class="fas fa-link"></i> ${escapeHtml(wd.walletAddress)}</div>`;
        }
        if (wd.status === 'rejected' && wd.rejectReason) {
            html += `<div class="reject-reason"><i class="fas fa-info-circle"></i> <strong>Reason:</strong> ${escapeHtml(wd.rejectReason)}</div>`;
        }
        html += `</div>`;
        container.innerHTML += html;
    });
}

/* ============================================================
   UPDATE RELEASE WALLET DISPLAY
   ============================================================ */
function updateReleaseWalletDisplay() {
    const bal = getReleaseWallet();
    document.getElementById('releaseWalletBalance').textContent = formatRND(bal);
}

/* ============================================================
   ATTACH USER LISTENER (real-time)
   ============================================================ */
function attachUserListener(uid) {
    if (unsubUser) unsubUser();
    const userRef = ref(db, 'users/' + uid);
    unsubUser = onValue(userRef, (snap) => {
        if (!snap.exists()) {
            window.location.href = 'index.html';
            return;
        }
        userData = snap.val() || {};
        updateReleaseWalletDisplay();
        updateCooldownUI();
    });
}

/* ============================================================
   WITHDRAW SUBMIT
   ============================================================ */
async function submitWithdrawal() {
    if (isProcessing) return;

    const msgDiv = document.getElementById('message');
    msgDiv.innerHTML = '';

    const address = document.getElementById('address').value.trim();
    const releaseBal = getReleaseWallet();
    const cooldown = getCooldownStatus();

    /* --- Validations --- */
    if (!currentUser || !auth.currentUser) {
        msgDiv.innerHTML = '<div class="error">❌ Session expired. Please login again.</div>';
        return;
    }
    if (releaseBal < MIN_RELEASE_BALANCE) {
        msgDiv.innerHTML = `<div class="error">❌ Insufficient release balance. You need at least ${MIN_RELEASE_BALANCE} RND.</div>`;
        showToast(`You need at least ${MIN_RELEASE_BALANCE} RND in Release Wallet.`, 'error');
        return;
    }
    if (!cooldown.canWithdraw) {
        msgDiv.innerHTML = `<div class="error">❌ Cooldown active. Next withdrawal in ${formatCooldown(cooldown.remainingMs)}.</div>`;
        return;
    }
    if (!address || !address.startsWith('0x') || address.length !== 42) {
        msgDiv.innerHTML = '<div class="error">❌ Please enter a valid BEP-20 wallet address (0x... 42 chars).</div>';
        return;
    }
    const normalizedAddress = address.toLowerCase();
    if (globalUsedAddresses.has(normalizedAddress)) {
        msgDiv.innerHTML = '<div class="warning">⚠️ This wallet address has already been used!</div>';
        showToast('This wallet address has already been used.', 'error');
        return;
    }

    isProcessing = true;
    updateButtonState();

    try {
        /* --- Fresh read to prevent race conditions --- */
        const freshSnap = await get(ref(db, 'users/' + currentUser.uid));
        const freshData = freshSnap.val() || {};
        const freshBalance = Number(freshData.releaseWallet) || 0;

        if (freshBalance < MIN_RELEASE_BALANCE) {
            msgDiv.innerHTML = '<div class="error">❌ Insufficient release balance (fresh check).</div>';
            return;
        }

        /* --- Re-check cooldown against fresh withdrawals --- */
        const allWithdrawalsSnap = await get(ref(db, 'withdrawals'));
        let latestTime = 0;
        let addressAlreadyUsed = false;
        allWithdrawalsSnap.forEach((child) => {
            const d = child.val();
            if (d.uid === currentUser.uid) {
                const t = new Date(d.date).getTime();
                if (t > latestTime) latestTime = t;
            }
            if (d.walletAddress && d.walletAddress.toLowerCase().trim() === normalizedAddress) {
                addressAlreadyUsed = true;
            }
        });

        if (addressAlreadyUsed) {
            msgDiv.innerHTML = '<div class="warning">⚠️ This wallet address was just used! Please try another.</div>';
            return;
        }

        if (latestTime > 0 && (Date.now() - latestTime) < COOLDOWN_MS) {
            const remaining = COOLDOWN_MS - (Date.now() - latestTime);
            msgDiv.innerHTML = `<div class="error">❌ Cooldown active. Next withdrawal in ${formatCooldown(remaining)}.</div>`;
            return;
        }

        /* --- Deduct from releaseWallet --- */
        const newBalance = roundTo(freshBalance - WITHDRAW_AMOUNT);
        await update(ref(db, 'users/' + currentUser.uid), {
            releaseWallet: newBalance
        });

        /* --- Create withdrawal request --- */
        const withdrawalRef = push(ref(db, 'withdrawals'));
        await set(withdrawalRef, {
            uid: currentUser.uid,
            amount: WITHDRAW_AMOUNT,
            walletType: 'releaseWallet',
            walletAddress: address,
            status: 'pending',
            rejectReason: null,
            date: new Date().toISOString()
        });

        /* --- Reload and update --- */
        globalUsedAddresses.add(normalizedAddress);
        await loadUserWithdrawals();
        document.getElementById('address').value = '';
        const hint = document.getElementById('addressHint');
        hint.innerHTML = '<i class="fas fa-info-circle"></i> Enter your valid BEP-20 (BNB Chain) wallet address';
        hint.className = 'address-hint';

        msgDiv.innerHTML = `
            <div class="success">
                ✅ Withdrawal request submitted successfully!<br>
                📌 Amount: <strong>5 RND</strong><br>
                ⏳ Processed within 2-3 days.<br>
                🔒 Next withdrawal available after <strong>30 days</strong>.
            </div>`;
        showToast('Withdrawal request submitted! Next available in 30 days.', 'success');

    } catch (err) {
        console.error('Withdrawal error:', err);
        msgDiv.innerHTML = '<div class="error">❌ Something went wrong. Please try again.</div>';
    } finally {
        isProcessing = false;
        updateButtonState();
        updateCooldownUI();
    }
}

/* ============================================================
   BIND EVENTS
   ============================================================ */
function bindEvents() {
    const btn = document.getElementById('withdrawBtn');
    btn.addEventListener('click', submitWithdrawal);

    const addressInput = document.getElementById('address');
    addressInput.addEventListener('input', function () {
        checkAddress(this.value);
    });

    // Live cooldown timer
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => {
        updateCooldownUI();
    }, 1000);
}

/* ============================================================
   AUTH BOOTSTRAP
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.replace('index.html');
        return;
    }
    currentUser = user;

    /* Load global used addresses first */
    await loadGlobalAddresses();

    /* Attach real-time user listener */
    attachUserListener(user.uid);

    /* Load user's own withdrawals */
    await loadUserWithdrawals();

    /* Bind UI */
    bindEvents();
    updateButtonState();
});

/* ============================================================
   NAVIGATION
   ============================================================ */
window.toggleSidebar = function () {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('open');
};

window.navigateTo = function (page) {
    const routes = {
        'dashboard': 'dashboard.html',
        'profile': 'profile.html',
        'spin': 'spin.html',
        'tasks': 'social-tasks.html',
        'staking': 'dashboard.html',
        'withdraw': 'withdraw.html'
    };
    if (routes[page]) window.location.href = routes[page];
};

window.logout = async function () {
    try {
        if (unsubUser) { unsubUser(); unsubUser = null; }
        if (tickTimer) clearInterval(tickTimer);
        await signOut(auth);
        localStorage.clear();
        sessionStorage.clear();
        window.location.replace('index.html');
    } catch (e) {
        window.location.replace('index.html');
    }
};

window.addEventListener('pageshow', (event) => {
    if (event.persisted && !auth.currentUser) {
        window.location.replace('index.html');
    }
});

window.addEventListener('beforeunload', () => {
    if (unsubUser) unsubUser();
    if (tickTimer) clearInterval(tickTimer);
});

console.log('💸 RND Withdraw module loaded');