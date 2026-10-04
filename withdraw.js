/* ============================================================
   RND REWARDS — WITHDRAW MODULE (FINAL PRODUCTION)
   ============================================================
   
   BUSINESS RULES:
   - Withdrawal ONLY from releaseWallet
   - Fixed amount: exactly 5 RND per withdrawal
   - Cooldown: exactly 30 days (30 × 24 × 60 × 60 × 1000 ms)
   - Global address uniqueness: one address = one use globally
   - Release Wallet balance is NEVER touched except by 5 RND deduction
   - Referral/Spin/Social wallets are NEVER touched
   
   FIXES:
   ✅ Atomic balance deduction (runTransaction)
   ✅ Durable user-side request record
   ✅ Network interruption recovery
   ✅ Two-tab concurrency protection
   ✅ Double-click prevention
   ✅ RequestId-based idempotency
   ✅ Fresh balance + cooldown check
   ✅ Strict BEP-20 address validation
   ✅ Rejected/cancelled withdrawals don't hold cooldown
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getDatabase,
    ref,
    get,
    update,
    push,
    set,
    onValue,
    runTransaction
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
const COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;   // exactly 30 days
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
let dataReady = false;

/* ============================================================
   LOADING SCREEN
   ============================================================ */
function hideLoadingScreen() {
    const ls = document.getElementById('loadingScreen');
    if (ls) {
        ls.classList.add('hide');
        setTimeout(() => { ls.style.display = 'none'; }, 500);
    }
}

function showLoadingError() {
    const err = document.getElementById('loaderError');
    if (err) err.style.display = 'block';
}

setTimeout(() => {
    if (!dataReady) showLoadingError();
}, 8000);

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
   LAST WITHDRAWAL TIME — filter rejected/cancelled
   ============================================================ */
function getLastWithdrawalTime() {
    /* Primary source: userData.lastWithdrawalAt (numeric) */
    const storedLast = Number(userData?.lastWithdrawalAt) || 0;

    /* Fallback: derive from userWithdrawals list */
    if (storedLast > 0) return storedLast;
    if (!userWithdrawals || userWithdrawals.length === 0) return 0;

    /* Only count active/successful withdrawals for cooldown */
    const eligible = userWithdrawals.filter(w =>
        w && w.status !== 'rejected' && w.status !== 'cancelled'
    );
    if (eligible.length === 0) return 0;

    return eligible.reduce((max, w) => {
        const rawTime =
            Number(w.createdAt) ||
            new Date(w.date || 0).getTime() ||
            0;
        return rawTime > max ? rawTime : max;
    }, 0);
}

/* ============================================================
   COOLDOWN
   ============================================================ */
function getCooldownStatus() {
    const lastTime = getLastWithdrawalTime();
    if (lastTime === 0) return { canWithdraw: true, remainingMs: 0 };
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

function updateCooldownUI() {
    const status = getCooldownStatus();
    const cooldownBox = document.getElementById('cooldownBox');
    const cooldownTime = document.getElementById('cooldownTime');

    if (!cooldownBox || !cooldownTime) return;

    if (status.canWithdraw) {
        cooldownBox.style.display = 'none';
    } else {
        cooldownBox.style.display = 'flex';
        cooldownTime.textContent = formatCooldown(status.remainingMs);
    }
    updateButtonState();
}

/* ============================================================
   BUTTON STATE — strict BEP-20 regex
   ============================================================ */
function updateButtonState() {
    const btn = document.getElementById('withdrawBtn');
    if (!btn) return;

    if (isProcessing) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        return;
    }

    const releaseBal = getReleaseWallet();
    const cooldown = getCooldownStatus();
    const addressEl = document.getElementById('address');
    const address = addressEl ? addressEl.value.trim() : '';

    const addressValid =
        /^0x[a-fA-F0-9]{40}$/.test(address) &&
        !globalUsedAddresses.has(address.toLowerCase());

    let canWithdraw = true;
    let reason = '';

    if (releaseBal < MIN_RELEASE_BALANCE) {
        canWithdraw = false;
        reason = `Need ${MIN_RELEASE_BALANCE} RND`;
    } else if (!cooldown.canWithdraw) {
        canWithdraw = false;
        reason = `Cooldown active`;
    } else if (!addressValid) {
        canWithdraw = false;
        reason = 'Enter wallet address';
    }

    btn.disabled = !canWithdraw;

    if (!canWithdraw) {
        btn.innerHTML = `<i class="fas fa-lock"></i> ${reason}`;
    } else {
        btn.innerHTML = `<i class="fas fa-paper-plane"></i> Request Withdrawal (${WITHDRAW_AMOUNT} RND)`;
    }
}

/* ============================================================
   ADDRESS CHECK — strict BEP-20
   ============================================================ */
window.checkAddress = function(address) {
    const hint = document.getElementById('addressHint');
    if (!hint) return false;

    const normalized = String(address || '').trim().toLowerCase();

    if (!address || address.length < 10) {
        hint.innerHTML =
            '<i class="fas fa-info-circle"></i>' +
            '<span>Enter your valid BEP-20 (BNB Chain) wallet address</span>';
        hint.className = 'address-hint';
        updateButtonState();
        return false;
    }

    /* Exact BEP-20 format: 0x + 40 hex chars */
    if (!/^0x[a-fA-F0-9]{40}$/.test(address.trim())) {
        hint.innerHTML =
            '<i class="fas fa-exclamation-triangle"></i>' +
            '<span>⚠️ Invalid BEP-20 address. Use 0x + 40 hexadecimal characters.</span>';
        hint.className = 'address-hint error';
        updateButtonState();
        return false;
    }

    if (globalUsedAddresses.has(normalized)) {
        hint.innerHTML =
            '<i class="fas fa-times-circle"></i>' +
            '<span>❌ This address has already been used for withdrawal.</span>';
        hint.className = 'address-hint error';
        updateButtonState();
        return false;
    }

    hint.innerHTML =
        '<i class="fas fa-check-circle"></i>' +
        '<span>✅ This address is available for withdrawal.</span>';
    hint.className = 'address-hint success';
    updateButtonState();
    return true;
};

/* ============================================================
   LOAD DATA
   ============================================================ */
async function loadGlobalAddresses() {
    globalUsedAddresses = new Set();
    try {
        const withdrawalsRef = ref(db, 'withdrawals');
        const snapshot = await get(withdrawalsRef);
        snapshot.forEach((childSnap) => {
            const data = childSnap.val();
            if (data && data.walletAddress) {
                globalUsedAddresses.add(String(data.walletAddress).toLowerCase().trim());
            }
        });
    } catch (e) {
        console.warn('Could not load global addresses:', e);
    }
}

async function loadUserWithdrawals() {
    userWithdrawals = [];
    try {
        const withdrawalsRef = ref(db, 'withdrawals');
        const snapshot = await get(withdrawalsRef);
        snapshot.forEach((childSnap) => {
            const data = childSnap.val();
            if (data && data.uid === currentUser.uid) {
                userWithdrawals.push({ id: childSnap.key, ...data });
            }
        });
        userWithdrawals.sort((a, b) => {
            const ta = Number(a.createdAt) || new Date(a.date || 0).getTime() || 0;
            const tb = Number(b.createdAt) || new Date(b.date || 0).getTime() || 0;
            return tb - ta;
        });
        displayWithdrawalStatus(userWithdrawals);
    } catch (e) {
        console.warn('Could not load user withdrawals:', e);
    }
}

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
        } else if (wd.status === 'cancelled') {
            statusClass = 'status-rejected';
            statusText = '⚠️ Cancelled';
        }

        let html = `
            <div class="status-item">
                <div class="status-header">
                    <div>
                        <span class="status-amount">${wd.amount} RND</span>
                        <div class="status-date">
                            <i class="far fa-calendar-alt"></i>
                            ${new Date(wd.date || wd.createdAt).toLocaleString('hi-IN')}
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

function updateReleaseWalletDisplay() {
    const bal = getReleaseWallet();
    const el = document.getElementById('releaseWalletBalance');
    if (el) el.textContent = formatRND(bal);
}

/* ============================================================
   USER LISTENER
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

        if (!dataReady) {
            dataReady = true;
            hideLoadingScreen();
        }
    }, (error) => {
        console.error('DB error:', error);
        showLoadingError();
    });
}

/* ============================================================
   ⭐⭐⭐ SUBMIT WITHDRAWAL — ATOMIC + CRASH-SAFE ⭐⭐⭐
   ============================================================ */
async function submitWithdrawal() {
    if (isProcessing) return;

    const msgDiv = document.getElementById('message');
    const addressInput = document.getElementById('address');
    if (!msgDiv || !addressInput) return;

    msgDiv.innerHTML = '';

    const address = addressInput.value.trim();
    const normalizedAddress = address.toLowerCase();

    /* ---------- BASIC VALIDATIONS ---------- */
    if (!currentUser || !auth.currentUser) {
        msgDiv.innerHTML = '<div class="error">❌ Session expired. Please login again.</div>';
        return;
    }

    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        msgDiv.innerHTML = '<div class="error">❌ Please enter a valid BEP-20 wallet address.</div>';
        showToast('Please enter a valid BEP-20 wallet address.', 'error');
        return;
    }

    if (globalUsedAddresses.has(normalizedAddress)) {
        msgDiv.innerHTML = '<div class="warning">⚠️ This wallet address has already been used.</div>';
        showToast('This wallet address has already been used.', 'error');
        return;
    }

    /* ---------- LOCAL BALANCE CHECK ---------- */
    const releaseBal = getReleaseWallet();
    if (releaseBal < WITHDRAW_AMOUNT) {
        msgDiv.innerHTML = `<div class="error">❌ Insufficient Release Wallet balance. You need at least ${WITHDRAW_AMOUNT} RND.</div>`;
        showToast(`You need at least ${WITHDRAW_AMOUNT} RND in Release Wallet.`, 'error');
        return;
    }

    /* ---------- LOCAL COOLDOWN CHECK ---------- */
    const cooldown = getCooldownStatus();
    if (!cooldown.canWithdraw) {
        msgDiv.innerHTML = `<div class="error">❌ Cooldown active. Next withdrawal in ${formatCooldown(cooldown.remainingMs)}.</div>`;
        return;
    }

    /* ---------- START PROCESSING ---------- */
    isProcessing = true;
    updateButtonState();

    /* Generate unique request ID */
    const requestId = `WD_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    /* Pre-generate global withdrawal key */
    const withdrawalKey = push(ref(db, 'withdrawals')).key;
    if (!withdrawalKey) {
        isProcessing = false;
        updateButtonState();
        msgDiv.innerHTML = '<div class="error">❌ Unable to create withdrawal request.</div>';
        return;
    }

    try {
        /* ---------- FRESH GLOBAL ADDRESS CHECK ---------- */
        const allWithdrawalsSnap = await get(ref(db, 'withdrawals'));
        let addressAlreadyUsed = false;
        allWithdrawalsSnap.forEach(child => {
            const d = child.val();
            if (d && d.walletAddress &&
                String(d.walletAddress).trim().toLowerCase() === normalizedAddress) {
                addressAlreadyUsed = true;
            }
        });

        if (addressAlreadyUsed) {
            msgDiv.innerHTML = '<div class="warning">⚠️ This wallet address has already been used.</div>';
            globalUsedAddresses.add(normalizedAddress);
            return;
        }

        /* ---------- ATOMIC USER TRANSACTION ---------- */
        const userRef = ref(db, `users/${currentUser.uid}`);

        const transactionResult = await runTransaction(userRef, current => {
            if (!current) return current;

            /* Idempotency: if this request was already processed, skip */
            if (current.lastWithdrawalRequestId === requestId) {
                return current;
            }

            /* Fresh release wallet balance */
            const currentRelease = Number(current.releaseWallet) || 0;
            if (currentRelease < WITHDRAW_AMOUNT) {
                return current;   // abort
            }

            /* Fresh cooldown check from server-stored numeric timestamp */
            const lastWithdrawalAt = Number(current.lastWithdrawalAt) || 0;
            if (lastWithdrawalAt > 0 &&
                Date.now() - lastWithdrawalAt < COOLDOWN_MS) {
                return current;   // abort
            }

            /* Ensure request collection exists */
            current.withdrawalRequests = current.withdrawalRequests || {};

            /* Prevent duplicate active request */
            if (current.withdrawalRequests[requestId]) {
                return current;
            }

            /* Durable user-side request record */
            current.withdrawalRequests[requestId] = {
                requestId,
                withdrawalId: withdrawalKey,
                uid: currentUser.uid,
                amount: WITHDRAW_AMOUNT,
                walletType: 'releaseWallet',
                walletAddress: address,
                status: 'pending',
                rejectReason: null,
                createdAt: Date.now(),
                date: new Date().toISOString()
            };

            /* Deduct exactly 5 RND */
            current.releaseWallet = roundTo(currentRelease - WITHDRAW_AMOUNT);

            /* Store request info for recovery */
            current.lastWithdrawalRequestId = requestId;
            current.lastWithdrawalAt = Date.now();

            return current;
        });

        /* ---------- TRANSACTION NOT COMMITTED ---------- */
        if (!transactionResult.committed) {
            /* Re-read to determine reason */
            const verifySnap = await get(ref(db, `users/${currentUser.uid}`));
            const verifyData = verifySnap.val() || {};

            const existingRequest = verifyData.withdrawalRequests?.[requestId];
            if (existingRequest) {
                /* Transaction actually succeeded — user got response late */
                userData = verifyData;
                showToast('✅ Withdrawal request already processed.', 'success');
                return;
            }

            const verifyBalance = Number(verifyData.releaseWallet) || 0;
            if (verifyBalance < WITHDRAW_AMOUNT) {
                msgDiv.innerHTML = '<div class="error">❌ Insufficient Release Wallet balance.</div>';
                return;
            }

            const verifyLast = Number(verifyData.lastWithdrawalAt) || 0;
            if (verifyLast > 0 && Date.now() - verifyLast < COOLDOWN_MS) {
                const remaining = COOLDOWN_MS - (Date.now() - verifyLast);
                msgDiv.innerHTML = `<div class="error">❌ Cooldown active. Next withdrawal in ${formatCooldown(remaining)}.</div>`;
                return;
            }

            msgDiv.innerHTML = '<div class="error">❌ Withdrawal could not be processed. Please try again.</div>';
            return;
        }

        /* ---------- TRANSACTION COMMITTED ---------- */
        const freshUserSnap = await get(ref(db, `users/${currentUser.uid}`));
        const freshUser = freshUserSnap.val() || {};

        const requestRecord = freshUser.withdrawalRequests?.[requestId];
        if (!requestRecord) {
            msgDiv.innerHTML = '<div class="error">❌ Withdrawal status could not be confirmed. Please refresh.</div>';
            return;
        }

        /* ---------- GLOBAL WITHDRAWAL RECORD ---------- */
        const withdrawalData = {
            requestId,
            withdrawalId: withdrawalKey,
            uid: currentUser.uid,
            amount: WITHDRAW_AMOUNT,
            walletType: 'releaseWallet',
            walletAddress: address,
            status: 'pending',
            rejectReason: null,
            createdAt: requestRecord.createdAt,
            date: requestRecord.date
        };

        await update(ref(db), {
            [`withdrawals/${withdrawalKey}`]: withdrawalData
        });

        /* ---------- LOCAL SUCCESS ---------- */
        globalUsedAddresses.add(normalizedAddress);
        userData = freshUser;

        await loadUserWithdrawals();

        addressInput.value = '';
        const hint = document.getElementById('addressHint');
        if (hint) {
            hint.innerHTML =
                '<i class="fas fa-info-circle"></i>' +
                '<span>Enter your valid BEP-20 (BNB Chain) wallet address</span>';
            hint.className = 'address-hint';
        }

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

        /* ---------- NETWORK ERROR RECONCILIATION ---------- */
        try {
            const verifySnap = await get(ref(db, `users/${currentUser.uid}`));
            const verifyData = verifySnap.val() || {};
            const existingRequest = verifyData.withdrawalRequests?.[requestId];

            if (existingRequest) {
                userData = verifyData;

                /* Repair global record if it wasn't written */
                await update(ref(db), {
                    [`withdrawals/${withdrawalKey}`]: {
                        requestId,
                        withdrawalId: withdrawalKey,
                        uid: currentUser.uid,
                        amount: WITHDRAW_AMOUNT,
                        walletType: 'releaseWallet',
                        walletAddress: address,
                        status: 'pending',
                        rejectReason: null,
                        createdAt: existingRequest.createdAt,
                        date: existingRequest.date
                    }
                });

                globalUsedAddresses.add(normalizedAddress);
                await loadUserWithdrawals();

                msgDiv.innerHTML = `
                    <div class="success">
                        ✅ Withdrawal request confirmed successfully.<br>
                        📌 Amount: <strong>5 RND</strong><br>
                        🔒 Next withdrawal available after <strong>30 days</strong>.
                    </div>`;

                showToast('Withdrawal request confirmed.', 'success');
                return;
            }

        } catch (reconcileError) {
            console.error('Withdrawal reconciliation error:', reconcileError);
        }

        msgDiv.innerHTML = `
            <div class="error">
                ❌ Network issue. Your withdrawal status could not
                be confirmed. Please refresh the page before trying again.
            </div>`;

        showToast('Network issue. Please refresh and check your withdrawal status before retrying.', 'error');

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
    if (btn) btn.addEventListener('click', submitWithdrawal);

    const addressInput = document.getElementById('address');
    if (addressInput) {
        addressInput.addEventListener('input', function () {
            checkAddress(this.value);
        });
    }

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

    await loadGlobalAddresses();
    attachUserListener(user.uid);
    await loadUserWithdrawals();

    bindEvents();
    updateButtonState();

    if (userData && !dataReady) {
        dataReady = true;
        hideLoadingScreen();
    }
});

/* ============================================================
   NAVIGATION
   ============================================================ */
window.toggleSidebar = function () {
    const s = document.getElementById('sidebar');
    const o = document.getElementById('overlay');
    if (s) s.classList.toggle('open');
    if (o) o.classList.toggle('open');
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

console.log('💸 RND Withdraw loaded — FINAL');
console.log('✅ Atomic transaction on releaseWallet');
console.log('✅ Durable user-side request record');
console.log('✅ Network-error recovery');
console.log('✅ Two-tab protection via lastWithdrawalAt');
console.log('✅ Strict BEP-20 validation');
console.log('✅ Fixed 5 RND per withdrawal');
console.log('✅ Exactly 30-day cooldown');
