/* ============================================================
   RND REWARDS — MY REFERRALS (profile page)
   Firebase Auth + Realtime Database
   Loading screen: data आने तक spinner
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, get } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* ---------- STATE ---------- */
let currentUser = null;
let allUsers = [];
let dataReady = false;

/* ============================================================
   LOADING SCREEN HELPERS
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

/* Timeout safety — 8 सेकंड में data न आए तो error */
setTimeout(() => {
    if (!dataReady) showLoadingError();
}, 8000);

/* ============================================================
   AUTH STATE
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    currentUser = user;

    try {
        await loadAllUsers();
        await loadReferrals();

        /* ⭐ Data आया — loading hide करो */
        dataReady = true;
        hideLoadingScreen();
    } catch (err) {
        console.error('Load error:', err);
        showLoadingError();
    }
});

/* ============================================================
   LOAD ALL USERS (for name/code lookup)
   ============================================================ */
async function loadAllUsers() {
    const usersRef = ref(db, 'users');
    const snapshot = await get(usersRef);
    const users = snapshot.val();
    allUsers = [];

    if (users) {
        for (let uid in users) {
            allUsers.push({
                uid: uid,
                name: users[uid].name || 'N/A',
                email: users[uid].email || 'N/A',
                referralCode: users[uid].referralCode || 'N/A',
                createdAt: users[uid].createdAt || new Date().toISOString()
            });
        }
    }
}

/* ============================================================
   LOAD REFERRALS (level1 / level2)
   ============================================================ */
async function loadReferrals() {
    const referralsRef = ref(db, 'referrals/' + currentUser.uid);
    const snapshot = await get(referralsRef);
    const referrals = snapshot.val() || { level1: [], level2: [] };

    const level1 = referrals.level1 || [];
    const level2 = referrals.level2 || [];

    displayReferrals('level1', level1);
    displayReferrals('level2', level2);

    const el1c = document.getElementById('level1Count');
    const el2c = document.getElementById('level2Count');
    const el1b = document.getElementById('level1Badge');
    const el2b = document.getElementById('level2Badge');

    if (el1c) el1c.innerText = level1.length;
    if (el2c) el2c.innerText = level2.length;
    if (el1b) el1b.innerHTML = level1.length + ' Members';
    if (el2b) el2b.innerHTML = level2.length + ' Members';
}

/* ============================================================
   DISPLAY REFERRALS
   ============================================================ */
function displayReferrals(level, referralIds) {
    const container = document.getElementById(level + 'List');
    if (!container) return;

    if (!referralIds || referralIds.length === 0) {
        if (level === 'level1') {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-user-plus"></i>
                    <p>No direct referrals yet</p>
                    <small>Share your referral link to invite friends!</small>
                </div>`;
        } else {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-users-slash"></i>
                    <p>No indirect referrals yet</p>
                    <small>When your direct referrals invite others, they'll appear here!</small>
                </div>`;
        }
        return;
    }

    container.innerHTML = '';
    referralIds.forEach((uid) => {
        const user = allUsers.find(u => u.uid === uid);
        if (user) {
            const div = document.createElement('div');
            div.className = 'referral-item';
            div.innerHTML = `
                <div class="referral-info">
                    <div class="referral-avatar"><i class="fas fa-user"></i></div>
                    <div>
                        <div class="referral-name">${escapeHtml(user.name)}</div>
                        <div class="referral-date">
                            <i class="far fa-calendar-alt"></i>
                            ${new Date(user.createdAt).toLocaleDateString('hi-IN')}
                        </div>
                    </div>
                </div>
                <div class="referral-code">${user.referralCode}</div>`;
            container.appendChild(div);
        }
    });
}

/* ============================================================
   UTILITY
   ============================================================ */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/* ============================================================
   NAVIGATION
   ============================================================ */
window.toggleSidebar = function() {
    document.getElementById('sidebar').classList.toggle('open');
    document.getElementById('overlay').classList.toggle('open');
};

window.navigateTo = function(page) {
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

window.logout = async function() {
    await signOut(auth);
    localStorage.clear();
    window.location.href = 'index.html';
};

console.log('👥 RND Referrals page loaded (with loading screen)');
