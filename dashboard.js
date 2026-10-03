/* ============================================================
   RND REWARDS — DASHBOARD + STAKING
   - 6 wallets: Total, Referral, Spin, SocialTasks, Release, TotalEarned
   - Staking unlock: दोनों social tasks पूरे होने चाहिए
   - Deduction priority: SocialTasks → Referral → Total → Spin
   - FIXED: Confirm button bug (fresh Firebase check)
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getDatabase, ref, get, onValue, runTransaction
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

const OFFICIAL_DOMAIN = "https://app.randigital.in";
const SOCIAL_LINKS = {
    facebook: "https://www.facebook.com/profile.php?id=61590396932149",
    twitter: "https://x.com/RanDigitalRND"
};

const STAKING_CONFIG = {
    BONUS_RATE: 0.20,
    LOCK_MONTHS: 6,
    DAILY_RELEASE_RATE: 0.02,
    MIN_WITHDRAWAL: 5,
    DECIMAL_PLACES: 8,
    MS_PER_DAY: 24 * 60 * 60 * 1000
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* ---------- STATE ---------- */
let currentUser = null;
let userData = null;
let stakes = {};
let realtimeListener = null;
let retryCount = 0;
const MAX_RETRIES = 2;
let tickTimer = null;
let pendingRequestId = null;
let isSubmitting = false;
let modalAmount = 0;
let isReconciling = false;

/* ============================================================
   HELPERS
   ============================================================ */
const roundTo = (n, dp = STAKING_CONFIG.DECIMAL_PLACES) =>
    Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

const calculateStakingBonus = (amount) => roundTo(amount * STAKING_CONFIG.BONUS_RATE);
const calculateTotalStaking = (amount) => roundTo(amount + calculateStakingBonus(amount));
const calculateDailyRelease = (totalAmount) => roundTo(totalAmount * STAKING_CONFIG.DAILY_RELEASE_RATE);

const calculateLockEndDate = (startMs) => {
    const d = new Date(startMs);
    d.setMonth(d.getMonth() + STAKING_CONFIG.LOCK_MONTHS);
    return d.getTime();
};

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
    const capped = Math.min(rawEligible, total);
    const remaining = roundTo(Math.max(total - capped, 0));
    const status = remaining <= 0 ? 'completed' : 'releasing';
    return { eligible: roundTo(capped), released: roundTo(capped), remaining, status, daysElapsed };
};

const formatRND = (n, dp = 2) =>
    (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });

const formatDate = (ms) => {
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
};

const generateStakeId = () => {
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `STK_${Date.now()}_${rand}`;
};

/* ============================================================
   WALLET READERS
   ============================================================ */
function getReferralWallet() { return Number(userData?.referralWallet) || 0; }
function getSpinWallet() { return Number(userData?.spinWallet) || 0; }
function getSocialTasksWallet() { return Number(userData?.socialTasksWallet) || 0; }
function getReleaseWallet() { return Number(userData?.releaseWallet) || 0; }
function getTotalEarned() { return Number(userData?.totalEarned) || 0; }

function getMainWallet() {
    if (userData?.totalBalance !== undefined && userData?.totalBalance !== null) {
        return Number(userData.totalBalance) || 0;
    }
    return getReferralWallet() + getSpinWallet() + getSocialTasksWallet();
}

/* Available for staking = SocialTasks + Referral + Main + Spin */
function getStakingAvailable() {
    return roundTo(
        getSocialTasksWallet() + getReferralWallet() + getMainWallet() + getSpinWallet(),
        8
    );
}

/* Are both social tasks complete? */
function areTasksCompleted() {
    const tasks = userData?.socialTasks || {};
    return tasks.facebook === true && tasks.twitter === true;
}

/* ⭐ NEW: Fresh check directly from Firebase (bypasses stale cache) */
async function fetchFreshUserData() {
    if (!currentUser) return null;
    try {
        const snap = await get(ref(db, `users/${currentUser.uid}`));
        if (snap.exists()) {
            const fresh = snap.val();
            /* Sync local state */
            userData = fresh;
            stakes = fresh.staking || {};
            return fresh;
        }
        return null;
    } catch (err) {
        console.error('Fresh fetch error:', err);
        return null;
    }
}

/* ⭐ NEW: Fresh task check — uses live Firebase data */
async function areTasksCompletedFresh() {
    const fresh = await fetchFreshUserData();
    if (!fresh) return false;
    const tasks = fresh.socialTasks || {};
    return tasks.facebook === true && tasks.twitter === true;
}

/* ============================================================
   TOAST
   ============================================================ */
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const text = document.getElementById('toastText');
    if (!toast || !text) return;
    toast.className = `toast ${type}`;
    text.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('show'), 3200);
}

/* ============================================================
   NUMBER ANIMATION
   ============================================================ */
function animateNumber(element, targetValue, decimals = 2) {
    if (!element) return;
    const currentRaw = parseFloat(element.innerText.replace(/,/g, ''));
    const start = isNaN(currentRaw) ? 0 : currentRaw;
    const target = parseFloat(targetValue);
    if (Math.abs(start - target) < 0.01) {
        element.innerText = target.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        return;
    }
    const duration = Math.min(400, 100 + Math.abs(target - start) * 2);
    const startTime = performance.now();
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(1, elapsed / duration);
        const easeOut = 1 - Math.pow(1 - progress, 2);
        const val = start + (target - start) * easeOut;
        element.innerText = val.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        if (progress < 1) requestAnimationFrame(update);
        else element.innerText = target.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    }
    requestAnimationFrame(update);
}

/* ============================================================
   ERROR STATE
   ============================================================ */
function showErrorAndLogout(message) {
    const loadingScreen = document.getElementById('loadingScreen');
    const errorEl = document.getElementById('loaderError');
    const errorMsg = document.getElementById('errorMessage');
    if (errorMsg) errorMsg.textContent = message || '⚠️ Unable to load account data.';
    if (errorEl) errorEl.style.display = 'block';
    if (loadingScreen) loadingScreen.classList.remove('hide');
    document.querySelectorAll('.stats-grid, .section, .header').forEach(el => {
        el.style.opacity = '0.3';
        el.style.pointerEvents = 'none';
    });
}

function hideErrorState() {
    const errorEl = document.getElementById('loaderError');
    if (errorEl) errorEl.style.display = 'none';
    document.querySelectorAll('.stats-grid, .section, .header').forEach(el => {
        el.style.opacity = '1';
        el.style.pointerEvents = 'auto';
    });
}

/* ============================================================
   LOAD USER DATA
   ============================================================ */
function loadUserData(user) {
    if (!user) { showErrorAndLogout('Please login again'); return; }
    if (realtimeListener) { realtimeListener(); realtimeListener = null; }

    const userRef = ref(db, 'users/' + user.uid);

    realtimeListener = onValue(userRef, (snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.val();

            if (data.status && data.status !== 'active') {
                showErrorAndLogout('Your account is not active. Please contact support.');
                return;
            }

            userData = data;
            stakes = data.staking || {};
            hideErrorState();
            const ls = document.getElementById('loadingScreen');
            if (ls) ls.classList.add('hide');

            reconcileAllReleases().catch(e => console.warn('Reconcile:', e));
            renderAll();
        } else {
            showErrorAndLogout('Account not found. Please contact support.');
            setTimeout(async () => {
                await signOut(auth);
                window.location.replace('index.html');
            }, 2000);
        }
    }, (error) => {
        console.error('Database error:', error);
        if (retryCount < MAX_RETRIES) {
            retryCount++;
            const el = document.getElementById('loaderError');
            if (el) el.style.display = 'block';
            const msg = document.getElementById('errorMessage');
            if (msg) msg.textContent = `⚠️ Connection issue. Retry ${retryCount}/${MAX_RETRIES}...`;
        } else {
            showErrorAndLogout('Network error. Please check your internet connection.');
            setTimeout(async () => {
                await signOut(auth);
                window.location.replace('index.html');
            }, 3000);
        }
    });
}

/* ============================================================
   RENDER ALL
   ============================================================ */
function renderAll() {
    if (!userData) return;
    renderWallets();
    renderStakingAvailable();
    renderSocialTasksWarning();
    renderSummary();
    renderActiveStakes();
    renderHistory();
    renderReferral();
    renderUserName();
    updateCalculator();
    updateStakeButtonState();
}

function renderUserName() {
    const n = userData?.name && String(userData.name).trim() ? String(userData.name).trim() : 'User';
    const el = document.getElementById('userName');
    if (el) el.innerText = n;
}

function renderWallets() {
    animateNumber(document.getElementById('totalBalance'), getMainWallet(), 2);
    animateNumber(document.getElementById('referralWallet'), getReferralWallet(), 2);
    animateNumber(document.getElementById('spinWallet'), getSpinWallet(), 2);
    animateNumber(document.getElementById('socialTasksWallet'), getSocialTasksWallet(), 2);
    animateNumber(document.getElementById('releaseWallet'), getReleaseWallet(), 2);
    animateNumber(document.getElementById('totalEarned'), getTotalEarned(), 2);
}

function renderStakingAvailable() {
    animateNumber(document.getElementById('stakingAvailable'), getStakingAvailable(), 2);
}

function renderSocialTasksWarning() {
    const banner = document.getElementById('socialTasksWarning');
    if (!banner) return;
    banner.style.display = areTasksCompleted() ? 'none' : 'block';
}

function aggregateStakes() {
    let totalStaked = 0, totalBonus = 0, totalAvailable = 0, totalLocked = 0;
    const now = Date.now();
    for (const s of Object.values(stakes || {})) {
        const calc = calculateEligibleRelease(s, now);
        totalStaked += Number(s.principalAmount) || 0;
        totalBonus += Number(s.bonusAmount) || 0;
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
    const e1 = document.getElementById('sumTotalStaked');
    const e2 = document.getElementById('sumBonus');
    const e3 = document.getElementById('sumAvailable');
    const e4 = document.getElementById('sumLocked');
    if (e1) e1.textContent = `${formatRND(agg.totalStaked)} RND`;
    if (e2) e2.textContent = `${formatRND(agg.totalBonus)} RND`;
    if (e3) e3.textContent = `${formatRND(agg.totalAvailable)} RND`;
    if (e4) e4.textContent = `${formatRND(agg.totalLocked)} RND`;
}

function renderReferral() {
    const linkInput = document.getElementById('referralLink');
    if (!linkInput) return;
    if (userData?.referralCode) {
        linkInput.value = `${OFFICIAL_DOMAIN}/?ref=${userData.referralCode}`;
        linkInput.placeholder = 'Referral code';
    } else {
        linkInput.value = '';
        linkInput.placeholder = 'Referral code unavailable';
    }
}

/* ============================================================
   ACTIVE STAKES
   ============================================================ */
function renderActiveStakes() {
    const container = document.getElementById('activeStakesContainer');
    if (!container) return;
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
        : calc.status === 'releasing' ? 'status-releasing' : 'status-completed';
    const statusText = calc.status.toUpperCase();

    let progressPct = 0, progressLabel = '';
    if (calc.status === 'locked') {
        const totalLockMs = lockEnd - start;
        const elapsed = Math.min(now - start, totalLockMs);
        progressPct = totalLockMs > 0 ? (elapsed / totalLockMs) * 100 : 100;
        progressLabel = 'Lock Progress';
    } else {
        progressPct = total > 0 ? (calc.released / total) * 100 : 100;
        progressLabel = 'Release Progress';
    }

    let countdownHTML = '';
    if (calc.status === 'locked') {
        countdownHTML = `<div class="countdown-box"><div class="countdown-label">Release Starts In</div><div class="countdown-value" data-countdown-to="${lockEnd}">—</div></div>`;
    } else if (calc.status === 'releasing') {
        countdownHTML = `<div class="countdown-box"><div class="countdown-label">Next Release In</div><div class="countdown-value" data-countdown-next="${lockEnd}">—</div></div>`;
    } else {
        countdownHTML = `<div class="countdown-box"><div class="countdown-label">Status</div><div class="countdown-value done">FULLY RELEASED</div></div>`;
    }

    return `
    <div class="stake-card">
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
    if (!container) return;
    const list = Object.values(stakes || {}).sort((a, b) =>
        (b.stakeStartAt || 0) - (a.stakeStartAt || 0));

    if (list.length === 0) {
        container.innerHTML = `<div class="empty-state"><i class="fas fa-inbox"></i><p>Your staking history will appear here.</p></div>`;
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
   COUNTDOWN
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
        if (now >= target) {
            el.classList.add('done');
            el.textContent = 'LOCK COMPLETE';
        } else {
            el.textContent = formatDuration(target - now);
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
   CALCULATOR
   ============================================================ */
function readStakeInput() {
    const el = document.getElementById('stakeAmountInput');
    if (!el) return 0;
    const raw = parseFloat(el.value);
    return isNaN(raw) || raw < 0 ? 0 : raw;
}

function updateCalculator() {
    const amt = readStakeInput();
    const bonus = calculateStakingBonus(amt);
    const total = calculateTotalStaking(amt);
    const daily = calculateDailyRelease(total);

    const c1 = document.getElementById('cPrincipal');
    const c2 = document.getElementById('cBonus');
    const c3 = document.getElementById('cTotal');
    const c4 = document.getElementById('cDaily');
    if (c1) c1.textContent = `${formatRND(amt)} RND`;
    if (c2) c2.textContent = `+${formatRND(bonus)} RND`;
    if (c3) c3.textContent = `${formatRND(total)} RND`;
    if (c4) c4.textContent = `${formatRND(daily)} RND`;
}

function updateStakeButtonState() {
    const btn = document.getElementById('stakeBtn');
    if (!btn) return;

    if (isSubmitting) { btn.disabled = true; return; }

    /* Tasks check */
    if (!areTasksCompleted()) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-tasks"></i> COMPLETE SOCIAL TASKS FIRST';
        return;
    }

    const amt = readStakeInput();
    const available = getStakingAvailable();
    const valid = amt > 0 && amt <= available + 1e-9;
    btn.disabled = !valid;

    if (amt > 0 && amt > available) {
        btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i> INSUFFICIENT BALANCE';
    } else {
        btn.innerHTML = '<i class="fas fa-lock"></i> STAKE FOR 6 MONTHS';
    }
}

function bindStakeInput() {
    const input = document.getElementById('stakeAmountInput');
    if (!input) return;
    input.addEventListener('input', () => {
        let v = input.value;
        if (v === '') { updateCalculator(); updateStakeButtonState(); return; }
        const n = parseFloat(v);
        if (isNaN(n) || n < 0) {
            input.value = '';
            updateCalculator(); updateStakeButtonState(); return;
        }
        const [intPart, decPart] = v.split('.');
        if (decPart && decPart.length > 8) {
            input.value = `${intPart}.${decPart.slice(0, 8)}`;
        }
        updateCalculator();
        updateStakeButtonState();
    });
}

window.setStakeMax = function() {
    const available = getStakingAvailable();
    const el = document.getElementById('stakeAmountInput');
    if (!el) return;
    el.value = available.toFixed(2);
    updateCalculator();
    updateStakeButtonState();
};

/* ============================================================
   MODAL — ⭐ FIXED with fresh data check
   ============================================================ */
window.openStakeModal = async function() {
    /* ⭐ Fresh data fetch करो */
    const fresh = await fetchFreshUserData();
    if (!fresh) {
        showToast('Unable to load account data.', 'error');
        return;
    }

    /* ⭐ अब fresh check */
    if (!areTasksCompleted()) {
        showToast('Please complete Social Tasks first!', 'error');
        setTimeout(() => { window.location.href = 'social-tasks.html'; }, 1500);
        return;
    }

    const amt = readStakeInput();
    const available = getStakingAvailable();
    if (amt <= 0) { showToast('Please enter a valid RND amount.', 'error'); return; }
    if (amt > available + 1e-9) { showToast('Insufficient RND balance.', 'error'); return; }

    modalAmount = amt;
    const bonus = calculateStakingBonus(amt);
    const total = calculateTotalStaking(amt);
    const daily = calculateDailyRelease(total);

    const m1 = document.getElementById('mPrincipal');
    const m2 = document.getElementById('mBonus');
    const m3 = document.getElementById('mTotal');
    const m4 = document.getElementById('mDaily');
    const m5 = document.getElementById('mWarnPrincipal');
    if (m1) m1.textContent = `${formatRND(amt)} RND`;
    if (m2) m2.textContent = `${formatRND(bonus)} RND`;
    if (m3) m3.textContent = `${formatRND(total)} RND`;
    if (m4) m4.textContent = `${formatRND(daily)} RND/day`;
    if (m5) m5.textContent = `${formatRND(amt)} RND`;

    const modal = document.getElementById('confirmModal');
    if (modal) modal.classList.add('show');
};

window.closeStakeModal = function() {
    const modal = document.getElementById('confirmModal');
    if (modal) modal.classList.remove('show');
    modalAmount = 0;
};

document.getElementById('confirmModal')?.addEventListener('click', (e) => {
    if (e.target.id === 'confirmModal') window.closeStakeModal();
});

/* ============================================================
   ⭐⭐⭐ ATOMIC STAKE CREATION — FULLY FIXED ⭐⭐⭐
   Priority: SocialTasks → Referral → Total → Spin
   FIX: Fresh Firebase check before processing
   ============================================================ */
window.confirmStake = async function() {
    /* ⭐ Double-click prevention */
    const confirmBtn = document.getElementById('confirmStakeBtn');
    if (!confirmBtn) return;
    if (confirmBtn.disabled) return;

    if (isSubmitting) { showToast('Already processing...', 'info'); return; }
    if (!currentUser || !auth.currentUser) { showToast('Session expired. Please login again.', 'error'); return; }
    if (modalAmount <= 0) { showToast('Please enter a valid RND amount.', 'error'); return; }

    isSubmitting = true;
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> CHECKING...';

    try {
        /* ⭐ STEP 1: Fresh data from Firebase */
        const freshSnap = await get(ref(db, `users/${currentUser.uid}`));
        const freshData = freshSnap.val() || {};

        /* ⭐ STEP 2: Fresh tasks check */
        const freshTasks = freshData.socialTasks || {};
        if (freshTasks.facebook !== true || freshTasks.twitter !== true) {
            showToast('Please complete Social Tasks first!', 'error');
            window.closeStakeModal();
            isSubmitting = false;
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = 'CONFIRM STAKE';
            /* Auto-redirect */
            setTimeout(() => { window.location.href = 'social-tasks.html'; }, 1500);
            return;
        }

        /* ⭐ STEP 3: Sync local state */
        userData = freshData;
        stakes = freshData.staking || {};

        /* ⭐ STEP 4: Fresh balance check */
        const refW = Number(freshData.referralWallet) || 0;
        const mainW = (freshData.totalBalance !== undefined && freshData.totalBalance !== null)
            ? Number(freshData.totalBalance) || 0
            : refW;
        const spinW = Number(freshData.spinWallet) || 0;
        const taskW = Number(freshData.socialTasksWallet) || 0;
        const combined = refW + mainW + spinW + taskW;

        if (modalAmount > combined + 1e-9) {
            showToast('Insufficient RND balance.', 'error');
            window.closeStakeModal();
            isSubmitting = false;
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = 'CONFIRM STAKE';
            return;
        }

        /* STEP 5: अब actual transaction */
        confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> PROCESSING...';

        if (!pendingRequestId) {
            pendingRequestId = `REQ_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }

        const principal = roundTo(modalAmount);
        const bonus = calculateStakingBonus(principal);
        const total = calculateTotalStaking(principal);
        const daily = calculateDailyRelease(total);
        const stakeId = generateStakeId();
        const now = Date.now();
        const lockEnd = calculateLockEndDate(now);

        const rootRef = ref(db, `users/${currentUser.uid}`);

        const result = await runTransaction(rootRef, (cur) => {
            if (!cur) return cur;
            if (cur._lastStakeRequestId === pendingRequestId) return;

            /* Server-side double check */
            const tasks = cur.socialTasks || {};
            if (tasks.facebook !== true || tasks.twitter !== true) return;

            const rW = Number(cur.referralWallet) || 0;
            const mW = (cur.totalBalance !== undefined && cur.totalBalance !== null)
                ? Number(cur.totalBalance) || 0
                : rW;
            const sW = Number(cur.spinWallet) || 0;
            const tW = Number(cur.socialTasksWallet) || 0;

            const cmb = rW + mW + sW + tW;
            if (principal > cmb + 1e-9) return;

            /* Deduct priority: SocialTasks → Referral → Total → Spin */
            let remaining = principal;

            /* 1. Social Tasks */
            const fromTasks = Math.min(tW, remaining);
            cur.socialTasksWallet = roundTo(tW - fromTasks);
            remaining -= fromTasks;

            /* 2. Referral */
            if (remaining > 0) {
                const fromRef = Math.min(rW, remaining);
                cur.referralWallet = roundTo(rW - fromRef);
                remaining -= fromRef;
            } else {
                cur.referralWallet = roundTo(rW);
            }

            /* 3. Total Balance */
            if (remaining > 0) {
                const fromMain = Math.min(mW, remaining);
                cur.totalBalance = roundTo(mW - fromMain);
                remaining -= fromMain;
            } else {
                cur.totalBalance = roundTo(mW);
            }

            /* 4. Spin */
            if (remaining > 0) {
                const fromSpin = Math.min(sW, remaining);
                cur.spinWallet = roundTo(sW - fromSpin);
                remaining -= fromSpin;
            } else {
                cur.spinWallet = roundTo(sW);
            }

            /* Init release wallet */
            if (cur.releaseWallet === undefined || cur.releaseWallet === null) {
                cur.releaseWallet = 0;
            }

            /* Create stake */
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
            /* Reason पता करो */
            const snap = await get(ref(db, `users/${currentUser.uid}`));
            const d = snap.val() || {};
            const tasks = d.socialTasks || {};

            if (d._lastStakeRequestId === pendingRequestId) {
                showToast('Already processed.', 'info');
            } else if (tasks.facebook !== true || tasks.twitter !== true) {
                showToast('Complete Social Tasks first.', 'error');
                setTimeout(() => { window.location.href = 'social-tasks.html'; }, 1500);
            } else {
                showToast('Insufficient RND balance.', 'error');
            }
            return;
        }

        /* SUCCESS */
        window.closeStakeModal();
        showToast(`✅ ${formatRND(principal)} RND successfully staked.`, 'success');
        const inp = document.getElementById('stakeAmountInput');
        if (inp) inp.value = '';
        updateCalculator();
        pendingRequestId = null;

    } catch (err) {
        console.error('Stake error:', err);
        showToast('Unable to process staking right now.', 'error');
    } finally {
        isSubmitting = false;
        if (confirmBtn) {
            confirmBtn.disabled = false;
            confirmBtn.innerHTML = 'CONFIRM STAKE';
        }
        updateStakeButtonState();
    }
};

/* ============================================================
   RELEASE RECONCILIATION
   ============================================================ */
async function reconcileAllReleases() {
    if (!currentUser || !stakes || isReconciling) return;
    isReconciling = true;
    try {
        const now = Date.now();
        let totalNewRelease = 0;

        for (const [stakeId, stake] of Object.entries(stakes)) {
            const calc = calculateEligibleRelease(stake, now);
            const stored = Number(stake.releasedAmount) || 0;
            if (calc.released > stored + 1e-9) {
                const delta = roundTo(calc.released - stored);
                const success = await applyReleaseToStake(stakeId, calc.released);
                if (success) totalNewRelease += delta;
            }
        }

        if (totalNewRelease > 0) {
            const userRef = ref(db, `users/${currentUser.uid}`);
            await runTransaction(userRef, (cur) => {
                if (!cur) return cur;
                cur.releaseWallet = roundTo((Number(cur.releaseWallet) || 0) + totalNewRelease);
                cur.lastReleaseCreditedAt = Date.now();
                return cur;
            });
        }
    } finally {
        isReconciling = false;
    }
}

async function applyReleaseToStake(stakeId, newReleased) {
    const stakeRef = ref(db, `users/${currentUser.uid}/staking/${stakeId}`);
    let committed = false;
    await runTransaction(stakeRef, (cur) => {
        if (!cur) return cur;
        const stored = Number(cur.releasedAmount) || 0;
        const total = Number(cur.totalStakingAmount) || 0;
        if (newReleased <= stored + 1e-9) return cur;

        const capped = Math.min(newReleased, total);
        cur.releasedAmount = roundTo(capped);
        cur.availableAmount = roundTo(capped);
        cur.remainingAmount = roundTo(total - capped);
        cur.status = cur.remainingAmount <= 0 ? 'completed' : 'releasing';
        cur.lastReleaseAt = Date.now();
        committed = true;
        return cur;
    });
    return committed;
}

/* ============================================================
   RETRY
   ============================================================ */
window.retryLoad = function() {
    retryCount = 0;
    const e1 = document.getElementById('loaderError');
    if (e1) e1.style.display = 'none';
    const ls = document.getElementById('loadingScreen');
    if (ls) ls.classList.remove('hide');
    const user = auth.currentUser;
    if (user) loadUserData(user);
};

/* ============================================================
   AUTH BOOTSTRAP
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.replace('index.html'); return; }
    currentUser = user;
    loadUserData(user);
    bindStakeInput();
    updateCalculator();
});

/* ============================================================
   COPY / SOCIAL
   ============================================================ */
window.copyLink = function() {
    const inp = document.getElementById('referralLink');
    if (!inp || !inp.value) { showToast('No referral link available', 'error'); return; }
    const btn = document.querySelector('.copy-btn');
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(inp.value).then(() => {
            if (btn) {
                btn.classList.add('copied');
                btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            }
            showToast('✅ Referral link copied!', 'success');
            setTimeout(() => {
                if (btn) {
                    btn.classList.remove('copied');
                    btn.innerHTML = '<i class="fas fa-copy"></i> Copy';
                }
            }, 3000);
        }).catch(() => {
            inp.select();
            document.execCommand('copy');
            showToast('✅ Referral link copied!', 'success');
        });
    } else {
        inp.select();
        document.execCommand('copy');
        showToast('✅ Referral link copied!', 'success');
    }
};

window.openFacebook = function() { window.open(SOCIAL_LINKS.facebook, '_blank'); };
window.openTwitter = function() { window.open(SOCIAL_LINKS.twitter, '_blank'); };

/* ============================================================
   NAVIGATION
   ============================================================ */
window.toggleSidebar = function() {
    const s = document.getElementById('sidebar');
    const o = document.getElementById('overlay');
    if (s) s.classList.toggle('open');
    if (o) o.classList.toggle('open');
};

window.navigateTo = function(page) {
    const pages = {
        'dashboard': 'dashboard.html',
        'profile': 'profile.html',
        'spin': 'spin.html',
        'tasks': 'social-tasks.html',
        'staking': 'dashboard.html',
        'withdraw': 'withdraw.html'
    };
    if (pages[page]) window.location.href = pages[page];
};

/* ============================================================
   LOGOUT
   ============================================================ */
window.logout = async function() {
    try {
        if (realtimeListener) { realtimeListener(); realtimeListener = null; }
        if (tickTimer) clearInterval(tickTimer);
        await signOut(auth);
        localStorage.clear();
        sessionStorage.clear();
        window.location.replace('index.html');
    } catch (error) {
        console.error('Logout error:', error);
        window.location.replace('index.html');
    }
};

window.addEventListener('pageshow', (event) => {
    if (event.persisted && !auth.currentUser) {
        window.location.replace('index.html');
    }
});

window.addEventListener('beforeunload', () => {
    if (realtimeListener) realtimeListener();
    if (tickTimer) clearInterval(tickTimer);
});

console.log('🔒 RND Dashboard loaded — 6 wallets + tasks-unlock + FIXED confirm button');
