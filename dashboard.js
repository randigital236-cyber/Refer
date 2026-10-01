/* ============================================================
   RND REWARDS — DASHBOARD LOGIC
   Firebase Auth + Realtime Database
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* ---------- STATE ---------- */
let currentUser = null;
let userData = null;
let dataLoaded = false;
let realtimeListener = null;
let retryCount = 0;
const MAX_RETRIES = 2;

/* ============================================================
   TOAST
   ============================================================ */
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const text = document.getElementById('toastText');
    toast.className = `toast ${type}`;
    text.textContent = message;
    toast.classList.add('show');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

/* ============================================================
   SMOOTH NUMBER ANIMATION
   ============================================================ */
function animateNumber(element, targetValue, decimals = 2) {
    if (!element) return;
    const currentRaw = parseFloat(element.innerText.replace(/,/g, ''));
    const start = isNaN(currentRaw) ? 0 : currentRaw;
    const target = parseFloat(targetValue);
    if (Math.abs(start - target) < 0.01) {
        element.innerText = target.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
        return;
    }
    const duration = Math.min(400, 100 + Math.abs(target - start) * 2);
    const startTime = performance.now();
    function update(currentTime) {
        const elapsed = currentTime - startTime;
        let progress = Math.min(1, elapsed / duration);
        const easeOut = 1 - Math.pow(1 - progress, 2);
        const currentVal = start + (target - start) * easeOut;
        element.innerText = currentVal.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
        if (progress < 1) requestAnimationFrame(update);
        else element.innerText = target.toLocaleString(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals
        });
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

    errorMsg.textContent = message || '⚠️ Unable to load account data.';
    errorEl.style.display = 'block';
    loadingScreen.classList.remove('hide');

    document.querySelectorAll('.stats-grid, .section, .header').forEach(el => {
        el.style.opacity = '0.3';
        el.style.pointerEvents = 'none';
    });
}

function hideErrorState() {
    document.getElementById('loaderError').style.display = 'none';
    document.querySelectorAll('.stats-grid, .section, .header').forEach(el => {
        el.style.opacity = '1';
        el.style.pointerEvents = 'auto';
    });
}

/* ============================================================
   USER DATA LOADER (Realtime)
   ============================================================ */
function loadUserData(user) {
    if (!user) {
        showErrorAndLogout('Please login again');
        return;
    }

    if (realtimeListener) {
        realtimeListener();
        realtimeListener = null;
    }

    const userRef = ref(db, 'users/' + user.uid);

    realtimeListener = onValue(userRef, (snapshot) => {
        if (snapshot.exists()) {
            const data = snapshot.val();

            if (data.status && data.status !== 'active') {
                showErrorAndLogout('Your account is not active. Please contact support.');
                return;
            }

            userData = data;
            dataLoaded = true;
            hideErrorState();
            document.getElementById('loadingScreen').classList.add('hide');
            updateDashboardUI(data);

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
            const errorEl = document.getElementById('loaderError');
            errorEl.style.display = 'block';
            document.getElementById('errorMessage').textContent =
                `⚠️ Connection issue. Retry ${retryCount}/${MAX_RETRIES}...`;
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
   UI UPDATE
   ============================================================ */
function updateDashboardUI(user) {
    if (!user) return;

    const refWallet = parseFloat(user.referralWallet) || 0;
    const spinWalletVal = parseFloat(user.spinWallet) || 0;

    let totalBal;
    if (user.totalBalance !== undefined && user.totalBalance !== null) {
        totalBal = parseFloat(user.totalBalance);
    } else {
        totalBal = refWallet + spinWalletVal;
    }

    const totalEarnedVal = parseFloat(user.totalEarned) || 0;

    animateNumber(document.getElementById('referralWallet'), refWallet, 2);
    animateNumber(document.getElementById('spinWallet'), spinWalletVal, 2);
    animateNumber(document.getElementById('totalBalance'), totalBal, 2);
    animateNumber(document.getElementById('totalEarned'), totalEarnedVal, 2);

    const displayName = user.name && user.name.trim() ? user.name.trim() : 'User';
    document.getElementById('userName').innerText = displayName;

    const linkInput = document.getElementById('referralLink');
    if (user.referralCode) {
        linkInput.value = `${OFFICIAL_DOMAIN}/?ref=${user.referralCode}`;
        linkInput.placeholder = 'Referral code';
    } else {
        linkInput.value = '';
        linkInput.placeholder = 'Referral code unavailable';
    }
}

/* ============================================================
   RETRY
   ============================================================ */
window.retryLoad = function() {
    retryCount = 0;
    document.getElementById('loaderError').style.display = 'none';
    document.getElementById('loadingScreen').classList.remove('hide');
    const user = auth.currentUser;
    if (user) loadUserData(user);
};

/* ============================================================
   AUTH STATE
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.replace('index.html');
        return;
    }
    currentUser = user;
    loadUserData(user);
});

/* ============================================================
   COPY REFERRAL LINK
   ============================================================ */
window.copyLink = function() {
    const inp = document.getElementById('referralLink');
    if (!inp || !inp.value) {
        showToast('No referral link available', 'error');
        return;
    }

    const btn = document.querySelector('.copy-btn');

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(inp.value).then(() => {
            btn.classList.add('copied');
            btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            showToast('✅ Referral link copied!', 'success');
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.innerHTML = '<i class="fas fa-copy"></i> Copy';
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

/* ============================================================
   SOCIAL LINKS
   ============================================================ */
window.openFacebook = function() {
    window.open(SOCIAL_LINKS.facebook, '_blank');
};

window.openTwitter = function() {
    window.open(SOCIAL_LINKS.twitter, '_blank');
};

/* ============================================================
   NAVIGATION
   ============================================================ */
window.toggleSidebar = function() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('open');
};

window.navigateTo = function(page) {
    const pages = {
        'dashboard': 'dashboard.html',
        'profile': 'profile.html',
        'spin': 'spin.html',
        'tasks': 'social-tasks.html',
        'staking': 'staking.html',
        'withdraw': 'withdraw.html'
    };
    if (pages[page]) {
        window.location.href = pages[page];
    }
};

/* ============================================================
   LOGOUT
   ============================================================ */
window.logout = async function() {
    try {
        if (realtimeListener) {
            realtimeListener();
            realtimeListener = null;
        }
        await signOut(auth);
        localStorage.clear();
        sessionStorage.clear();
        window.location.replace('index.html');
    } catch (error) {
        console.error('Logout error:', error);
        window.location.replace('index.html');
    }
};

/* ============================================================
   Prevent Back Button After Logout
   ============================================================ */
window.addEventListener('pageshow', function(event) {
    if (event.persisted) {
        if (!auth.currentUser) {
            window.location.replace('index.html');
        }
    }
});

console.log('🔒 RND Rewards Dashboard loaded');
console.log('✅ Facebook: ' + SOCIAL_LINKS.facebook);
console.log('✅ Twitter: ' + SOCIAL_LINKS.twitter);
