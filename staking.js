/* ============================================================
   RND REWARDS — STAKING MODULE
   Firebase-backed staking: 20% bonus, 6-month lock, 2% daily release
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getDatabase, ref, get, onValue, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

/* ---------- CONFIG ---------- */
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

const STAKING_CONFIG = {
    BONUS_RATE: 0.20,
    LOCK_MONTHS: 6,
    DAILY_RELEASE_RATE: 0.02,
    MIN_WITHDRAWAL: 10,
    DECIMAL_PLACES: 8,
    MS_PER_DAY: 24 * 60 * 60 * 1000
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* ---------- STATE ---------- */
let currentUid = null;
let userRef = null;
let unsubUser = null;
let userData = null;
let stakes = {};
let tickTimer = null;
let pendingRequestId = null;
let isSubmitting = false;

/* ============================================================
   PURE CALCULATION HELPERS
   ============================================================ */
const roundTo = (n, dp = STAKING_CONFIG.DECIMAL_PLACES) =>
    Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

const calculateStakingBonus = (amount) =>
    roundTo(amount * STAKING_CONFIG.BONUS_RATE);

const calculateTotalStaking = (amount) =>
    roundTo(amount + calculateStakingBonus(amount));

const calculateDailyRelease = (totalAmount) =>
    roundTo(totalAmount * STAKING_CONFIG.DAILY_RELEASE_RATE);

/** Calendar-month-accurate lock end */
const calculateLockEndDate = (startMs) => {
    const d = new Date(startMs);
    d.setMonth(d.getMonth() + STAKING_CONFIG.LOCK_MONTHS);
    return d.getTime();
};

/**
 * Eligible release for a single stake at a given `now`.
 * Idempotent — based only on stored timestamps.
 * - Before lockEndAt: 0
 * - Otherwise: floor(daysSinceLockEnd) * dailyReleaseAmount, capped at total.
 */
const calculateEligibleRelease = (stake, now = Date.now()) => {
    if (!stake) return { eligible: 0, released: 0, remaining: 0, status: 'locked', daysElapsed: 0 };

    const total = Number(stake.totalStakingAmount) || 0;
    const stored = Number(stake.releasedAmount) || 0;
    const lockEnd = Number(stake.lockEndAt) || 0;

    if (now < lockEnd) {
        return { eligible: 0, released: stored, remaining: roundTo(total - stored), status: 'locked', daysElapsed: 0 };
    }

    const daysElapsed = Math.floor((now - lockEnd) / STAKING_CONFIG.MS_PER_DAY);
    const rawEligible = daysElapsed * Number(stake.dailyReleaseAmount || 0);
    // Cap at total — never compound, never exceed total
    const eligibleCapped = Math.min(rawEligible, total);
    const remaining = roundTo(Math.max(total - eligibleCapped, 0));
    const status = remaining <= 0 ? 'completed' : 'releasing';

    return {
        eligible: roundTo(eligibleCapped),
        released: roundTo(eligibleCapped),
        remaining,
        status,
        daysElapsed
    };
};

const formatRND = (n, dp = 2) =>
    (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

const formatDate = (ms) => {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
};

const formatDateTime = (ms) => {
    if (!ms) return '—';
    return new Date(ms).toLocaleString(undefined, {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
};

const generateStakeId = () => {
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `STK_${Date.now()}_${rand}`;
};

/* ============================================================
   TOAST
   ============================================================ */
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const text = document.getElementById('toastText');
    const icon = toast.querySelector('i');

    toast.className = `toast ${type}`;
    icon.className = type === 'success' ? 'fas fa-check-circle'
                   : type === 'error'   ? 'fas fa-exclamation-circle'
                   : 'fas fa-info-circle';
    text.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.remove('show'), 3200);
}

/* ============================================================
   UI HELPERS
   ============================================================ */
function setLoading(show, errorMsg = null) {
    const ls = document.getElementById('loadingScreen');
    const err = document.getElementById('loaderError');
    if (show) {
        ls.classList.remove('hide');
        err.style.display = errorMsg ? 'block' : 'none';
        if (errorMsg) document.getElementById('errorMessage').textContent = errorMsg;
    } else {
        ls.classList.add('hide');
    }
}

/* ============================================================
   LOAD USER + STAKE DATA
   ============================================================ */
function attachUserListener(uid) {
    userRef = ref(db, `users/${uid}`);

    unsubUser = onValue(userRef, (snap) => {
        if (!snap.exists()) {
            setLoading(true, 'Account not found. Please contact support.');
            return;
        }
        userData = snap.val();
        stakes = userData.staking || {};

        // Auto-apply any newly eligible releases (idempotent write)
        reconcileAllReleases().catch(e => console.warn('Reconcile error:', e));

        renderAll();
        setLoading(false);
    }, (err) => {
        console.error(err);
        setLoading(true, 'Network error. Please check your connection.');
    });
}

/* ============================================================
   RELEASE RECONCILIATION
   Persists eligible release amounts to Firebase.
   Uses runTransaction so concurrent tabs can't double-write.
   ============================================================ */
async function reconcileAllReleases() {
    if (!currentUid || !stakes) return;
    const now = Date.now();

    for (const [stakeId, stake] of Object.entries(stakes)) {
        const calc = calculateEligibleRelease(stake, now);
        const storedReleased = Number(stake.releasedAmount) || 0;

        // Only write if eligible > stored (i.e. new days have elapsed)
        if (calc.released > storedReleased + 1e-9) {
            await applyReleaseToStake(stakeId, calc);
        }
    }
}

async function applyReleaseToStake(stakeId, calc) {
    const stakeRef = ref(db, `users/${currentUid}/staking/${stakeId}`);
    await runTransaction(stakeRef, (cur) => {
        if (!cur) return cur;
        const now = Date.now();
        const fresh = calculateEligibleRelease(cur, now);
        const stored = Number(cur.releasedAmount) || 0;

        // Idempotency: never decrease, never exceed total
        if (fresh.released <= stored + 1e-9) return cur;

        const capped = Math.min(fresh.released, Number(cur.totalStakingAmount) || 0);
        cur.releasedAmount = roundTo(capped);
        cur.availableAmount = roundTo(capped);
        cur.remainingAmount = roundTo((Number(cur.totalStakingAmount) || 0) - capped);
        cur.status = cur.remainingAmount <= 0 ? 'completed' : 'releasing';
        cur.lastReleaseAt = now;
        return cur;
    });
}

/* ============================================================
   RENDER EVERYTHING
   ============================================================ */
function renderAll() {
    if (!userData) return;
    renderAvailableBalance();
    renderSummary();
    renderActiveStakes();
    renderHistory();
    updateStakeButtonState();
}

function renderAvailableBalance() {
    const bal = Number(userData.availableRND ?? userData.totalBalance ?? 0);
    document.getElementById('availableRND').innerHTML =
        `${formatRND(bal)}<span class="balance-unit">RND</span>`;
}

function getAvailableRND() {
    return Number(userData?.availableRND ?? userData?.totalBalance ?? 0);
}

function aggregateStakes() {
    let totalStaked = 0, totalBonus = 0, totalAvailable = 0, totalLocked = 0;
    const now = Date.now();
    for (const s of Object.values(stakes || {})) {
        const calc = calculateEligibleRelease(s, now);
        totalStaked += Number(s.principalAmount) || 0;
        totalBonus  += Number(s.bonusAmount) || 0;
        totalAvailable += calc.released;
        totalLocked += calc.remaining;
    }
    return {
        totalStaked: roundTo(totalStaked),
        totalBonus: roundTo(totalBonus),
        totalAvailable: roundTo(totalAvailable),
        totalLocked: roundTo(totalLocked)
    };
}

function renderSummary() {
    const agg = aggregateStakes();
    document.getElementById('sumTotalStaked').textContent = `${formatRND(agg.totalStaked)} RND`;
    document.getElementById('sumBonus').textContent = `${formatRND(agg.totalBonus)} RND`;
    document.getElementById('sumAvailable').textContent = `${formatRND(agg.totalAvailable)} RND`;
    document.getElementById('sumLocked').textContent = `${formatRND(agg.totalLocked)} RND`;
}

function renderActiveStakes() {
    const container = document.getElementById('activeStakesContainer');
    const list = Object.values(stakes || {}).sort((a, b) =>
        (b.stakeStartAt || 0) - (a.stakeStartAt || 0));

    if (list.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-lock-open"></i>
                <p>No active stakes yet.<br>Stake your RND to earn a 20% bonus.</p>
            </div>`;
        return;
    }

    const now = Date.now();
    container.innerHTML = list.map(s => renderStakeCard(s, now)).join('');

    // Start countdown ticker
    startTicker();
}

function renderStakeCard(s, now) {
    const calc = calculateEligibleRelease(s, now);
    const total = Number(s.totalStakingAmount) || 0;
    const principal = Number(s.principalAmount) || 0;
    const bonus = Number(s.bonusAmount) || 0;
    const daily = Number(s.dailyReleaseAmount) || 0;
    const lockEnd = Number(s.lockEndAt) || 0;
    const start = Number(s.stakeStartAt) || 0;

    const statusClass = calc.status === 'locked' ? 'status-locked'
                      : calc.status === 'releasing' ? 'status-releasing'
                      : 'status-completed';
    const statusText = calc.status.toUpperCase();

    // Progress: lock progress if locked, release progress if releasing
    let progressPct = 0;
    let progressLabel = '';
    if (calc.status === 'locked') {
        const totalLockMs = lockEnd - start;
        const elapsed = Math.min(now - start, totalLockMs);
        progressPct = totalLockMs > 0 ? (elapsed / totalLockMs) * 100 : 100;
        progressLabel = 'Lock Progress';
    } else {
        progressPct = total > 0 ? (calc.released / total) * 100 : 100;
        progressLabel = 'Release Progress';
    }

    // Countdown
    let countdownHTML = '';
    if (calc.status === 'locked') {
        countdownHTML = `
            <div class="countdown-box">
                <div class="countdown-label">Release Starts In</div>
                <div class="countdown-value" data-countdown-to="${lockEnd}">—</div>
            </div>`;
    } else if (calc.status === 'releasing') {
        countdownHTML = `
            <div class="countdown-box">
                <div class="countdown-label">Next Release In</div>
                <div class="countdown-value" data-countdown-next="${lockEnd}">—</div>
            </div>`;
    } else {
        countdownHTML = `
            <div class="countdown-box">
                <div class="countdown-label">Status</div>
                <div class="countdown-value done">FULLY RELEASED</div>
            </div>`;
    }

    return `
    <div class="stake-card" data-stake-id="${s.stakeId}">
        <div class="stake-head">
            <span class="stake-id">#${String(s.stakeId).slice(-12)}</span>
            <span class="status-badge ${statusClass}">${statusText}</span>
        </div>

        <div class="stake-grid">
            <div class="stake-item"><div class="si-label">Original Stake</div><div class="si-value">${formatRND(principal)} RND</div></div>
            <div class="stake-item"><div class="si-label">20% Bonus</div><div class="si-value gold">+${formatRND(bonus)} RND</div></div>
            <div class="stake-item"><div class="si-label">Total Locked</div><div class="si-value purple">${formatRND(total)} RND</div></div>
            <div class="stake-item"><div class="si-label">Daily Release</div><div class="si-value green">${formatRND(daily)} RND</div></div>
            <div class="stake-item"><div class="si-label">Released</div><div class="si-value green">${formatRND(calc.released)} RND</div></div>
            <div class="stake-item"><div class="si-label">Remaining</div><div class="si-value">${formatRND(calc.remaining)} RND</div></div>
        </div>

        <div class="stake-grid" style="grid-template-columns:1fr 1fr;">
            <div class="stake-item"><div class="si-label">Stake Date</div><div class="si-value" style="font-size:12px;">${formatDate(start)}</div></div>
            <div class="stake-item"><div class="si-label">Release Starts</div><div class="si-value" style="font-size:12px;">${formatDate(lockEnd)}</div></div>
        </div>

        <div class="progress-wrap">
            <div class="progress-head"><span>${progressLabel}</span><span>${progressPct.toFixed(2)}%</span></div>
            <div class="progress-track"><div class="progress-fill" style="width:${Math.min(progressPct,100)}%"></div></div>
        </div>

        ${countdownHTML}
    </div>`;
}

function renderHistory() {
    const container = document.getElementById('historyContainer');
    const list = Object.values(stakes || {}).sort((a, b) =>
        (b.stakeStartAt || 0) - (a.stakeStartAt || 0));

    if (list.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <p>Your staking history will appear here.</p>
            </div>`;
        return;
    }

    const now = Date.now();
    container.innerHTML = list.map(s => {
        const calc = calculateEligibleRelease(s, now);
        const color = calc.status === 'locked' ? '#facc15'
                    : calc.status === 'releasing' ? '#34d399' : '#9ca3af';
        return `
        <div class="history-item">
            <div class="hi-left">
                <div class="hi-id">#${String(s.stakeId).slice(-12)}</div>
                <div class="hi-amt">${formatRND(s.totalStakingAmount)} RND</div>
            </div>
            <div class="hi-right">
                <div class="hi-status" style="color:${color}">${calc.status.toUpperCase()}</div>
                <div class="hi-date">${formatDate(s.stakeStartAt)}</div>
            </div>
        </div>`;
    }).join('');
}

/* ============================================================
   COUNTDOWN TICKER
   ============================================================ */
function startTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(updateCountdowns, 1000);
    updateCountdowns();
}

function updateCountdowns() {
    const now = Date.now();
    document.querySelectorAll('[data-countdown-to]').forEach(el => {
        const target = Number(el.getAttribute('data-countdown-to'));
        el.textContent = formatDuration(target - now);
        if (now >= target) {
            el.classList.add('done');
            el.textContent = 'LOCK COMPLETE';
        }
    });
    document.querySelectorAll('[data-countdown-next]').forEach(el => {
        const lockEnd = Number(el.getAttribute('data-countdown-next'));
        const elapsed = now - lockEnd;
        const dayMs = STAKING_CONFIG.MS_PER_DAY;
        const nextAt = lockEnd + (Math.floor(elapsed / dayMs) + 1) * dayMs;
        el.textContent = formatDuration(nextAt - now);
    });
}

function formatDuration(ms) {
    if (ms <= 0) return 'LOCK COMPLETE';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}D ${String(h).padStart(2,'0')}H ${String(m).padStart(2,'0')}M`;
    return `${String(h).padStart(2,'0')}H ${String(m).padStart(2,'0')}M ${String(sec).padStart(2,'0')}S`;
}

/* ============================================================
   CALCULATOR INPUT
   ============================================================ */
function readStakeInput() {
    const el = document.getElementById('stakeAmountInput');
    const raw = parseFloat(el.value);
    return isNaN(raw) || raw < 0 ? 0 : raw;
}

function updateCalculator() {
    const amt = readStakeInput();
    const bonus = calculateStakingBonus(amt);
    const total = calculateTotalStaking(amt);
    const daily = calculateDailyRelease(total);

    document.getElementById('cPrincipal').textContent = `${formatRND(amt)} RND`;
    document.getElementById('cBonus').textContent = `+${formatRND(bonus)} RND`;
    document.getElementById('cTotal').textContent = `${formatRND(total)} RND`;
    document.getElementById('cDaily').textContent = `${formatRND(daily)} RND`;
}

function updateStakeButtonState() {
    const btn = document.getElementById('stakeBtn');
    const amt = readStakeInput();
    const available = getAvailableRND();

    if (isSubmitting) { btn.disabled = true; return; }

    const valid = amt > 0 && amt <= available + 1e-9;
    btn.disabled = !valid;

    // Inline feedback
    const label = btn.querySelector('i') ? btn : null;
    if (amt > 0 && amt > available) {
        btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> INSUFFICIENT BALANCE';
    } else if (amt > 0 && !valid) {
        btn.innerHTML = '<i class="fas fa-lock"></i> ENTER VALID AMOUNT';
    } else {
        btn.innerHTML = '<i class="fas fa-lock"></i> STAKE FOR 6 MONTHS';
    }
}

/* ============================================================
   CONFIRM MODAL
   ============================================================ */
let modalAmount = 0;

function openConfirmModal() {
    const amt = readStakeInput();
    const available = getAvailableRND();
    if (amt <= 0) { showToast('Please enter a valid RND amount.', 'error'); return; }
    if (amt > available + 1e-9) { showToast('Insufficient RND balance.', 'error'); return; }

    modalAmount = amt;
    const bonus = calculateStakingBonus(amt);
    const total = calculateTotalStaking(amt);
    const daily = calculateDailyRelease(total);

    document.getElementById('mPrincipal').textContent = `${formatRND(amt)} RND`;
    document.getElementById('mBonus').textContent = `${formatRND(bonus)} RND`;
    document.getElementById('mTotal').textContent = `${formatRND(total)} RND`;
    document.getElementById('mDaily').textContent = `${formatRND(daily)} RND/day`;
    document.getElementById('mWarnPrincipal').textContent = `${formatRND(amt)} RND`;

    document.getElementById('confirmModal').classList.add('show');
}

function closeModal() {
    document.getElementById('confirmModal').classList.remove('show');
    modalAmount = 0;
}

/* ============================================================
   ATOMIC STAKE CREATION
   ============================================================ */
async function confirmStake() {
    if (isSubmitting) { showToast('This staking request is already being processed.', 'info'); return; }
    if (!currentUid || !auth.currentUser) { showToast('Your session has expired. Please login again.', 'error'); return; }
    if (modalAmount <= 0) { showToast('Please enter a valid RND amount.', 'error'); return; }

    isSubmitting = true;
    const confirmBtn = document.getElementById('confirmStakeBtn');
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> PROCESSING...';

    // Idempotency key
    if (!pendingRequestId) pendingRequestId = `REQ_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

    const principal = roundTo(modalAmount);
    const bonus = calculateStakingBonus(principal);
    const total = calculateTotalStaking(principal);
    const daily = calculateDailyRelease(total);
    const stakeId = generateStakeId();
    const now = Date.now();
    const lockEnd = calculateLockEndDate(now);

    try {
        // ── ATOMIC: deduct available balance + create stake in one transaction ──
        // We do this by running a transaction on the user's root node. This ensures
        // no other tab can concurrently read-then-write the same balance.
        const rootRef = ref(db, `users/${currentUid}`);

        const result = await runTransaction(rootRef, (cur) => {
            if (!cur) return cur;

            // Guard against replay of same request
            if (cur._lastStakeRequestId === pendingRequestId) {
                return; // abort — same request already applied
            }

            const available = Number(cur.availableRND ?? cur.totalBalance ?? 0);
            if (principal > available + 1e-9) {
                return; // abort — insufficient
            }

            // Deduct principal only (bonus is NOT deducted — it's a staking reward)
            cur.availableRND = roundTo(available - principal);

            // Also keep totalBalance in sync if the dashboard uses it
            if (cur.totalBalance !== undefined) {
                cur.totalBalance = roundTo(Number(cur.totalBalance) - principal);
            }

            // Create stake record
            cur.staking = cur.staking || {};
            cur.staking[stakeId] = {
                stakeId,
                principalAmount: principal,
                bonusAmount: bonus,
                totalStakingAmount: total,
                bonusRate: STAKING_CONFIG.BONUS_RATE,
                dailyReleaseRate: STAKING_CONFIG.DAILY_RELEASE_RATE,
                dailyReleaseAmount: daily,
                stakeStartAt: now,
                lockEndAt: lockEnd,
                lastReleaseAt: null,
                releasedAmount: 0,
                availableAmount: 0,
                remainingAmount: total,
                status: 'locked',
                createdAt: now,
                requestId: pendingRequestId
            };

            cur._lastStakeRequestId = pendingRequestId;
            return cur;
        });

        if (!result.committed) {
            // Transaction aborted — figure out why
            const snap = await get(ref(db, `users/${currentUid}`));
            const d = snap.val() || {};
            const available = Number(d.availableRND ?? d.totalBalance ?? 0);
            if (d._lastStakeRequestId === pendingRequestId) {
                showToast('This staking request is already being processed.', 'info');
            } else if (principal > available + 1e-9) {
                showToast('Insufficient RND balance.', 'error');
            } else {
                showToast('Unable to process staking right now. Please try again.', 'error');
            }
            return;
        }

        closeModal();
        showToast(`✅ ${formatRND(principal)} RND successfully staked.`, 'success');
        document.getElementById('stakeAmountInput').value = '';
        updateCalculator();

        // Reset idempotency key so next stake gets a new one
        pendingRequestId = null;

    } catch (err) {
        console.error('Stake error:', err);
        showToast('Unable to process staking right now. Please try again.', 'error');
    } finally {
        isSubmitting = false;
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = 'CONFIRM STAKE';
        updateStakeButtonState();
    }
}

/* ============================================================
   INPUT LISTENERS
   ============================================================ */
function bindInputs() {
    const input = document.getElementById('stakeAmountInput');
    input.addEventListener('input', () => {
        // Sanitize: no negatives, cap decimals
        let v = input.value;
        if (v === '') { updateCalculator(); updateStakeButtonState(); return; }
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) {
            input.value = '';
            updateCalculator(); updateStakeButtonState(); return;
        }
        // Clamp to 8 decimals
        const [intPart, decPart] = v.split('.');
        if (decPart && decPart.length > 8) {
            input.value = `${intPart}.${decPart.slice(0, 8)}`;
        }
        updateCalculator();
        updateStakeButtonState();
    });
}

/* ============================================================
   PUBLIC HANDLERS (used by inline onclick in HTML)
   ============================================================ */
window.__goBack = () => window.location.href = 'dashboard.html';
window.__retryStaking = () => {
    setLoading(true);
    if (currentUid) attachUserListener(currentUid);
};
window.__setMax = () => {
    const available = getAvailableRND();
    document.getElementById('stakeAmountInput').value = available.toFixed(2);
    updateCalculator();
    updateStakeButtonState();
};
window.__openConfirm = openConfirmModal;
window.__closeModal = closeModal;
window.__confirmStake = confirmStake;

/* Close modal on overlay click */
document.getElementById('confirmModal').addEventListener('click', (e) => {
    if (e.target.id === 'confirmModal') closeModal();
});

/* ============================================================
   AUTH BOOTSTRAP
   ============================================================ */
onAuthStateChanged(auth, (user) => {
    if (!user) {
        window.location.replace('index.html');
        return;
    }
    currentUid = user.uid;
    attachUserListener(user.uid);
    bindInputs();
    updateCalculator();
});

/* Cleanup on unload */
window.addEventListener('beforeunload', () => {
    if (unsubUser) unsubUser();
    if (tickTimer) clearInterval(tickTimer);
});

console.log('🔒 RND Staking module loaded');