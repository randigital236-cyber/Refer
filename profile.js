/* ============================================================
   RND REWARDS — MY REFERRALS (profile page)
   Firebase Auth + Realtime Database
   Referral list logic: UNCHANGED
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

/* ============================================================
   AUTH STATE
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    currentUser = user;
    await loadAllUsers();
    await loadReferrals();
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

    document.getElementById('level1Count').innerText = level1.length;
    document.getElementById('level2Count').innerText = level2.length;
    document.getElementById('level1Badge').innerHTML = level1.length + ' Members';
    document.getElementById('level2Badge').innerHTML = level2.length + ' Members';
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
        'staking': 'dashboard.html',   // staking dashboard पर ही है
        'withdraw': 'withdraw.html'
    };
    if (routes[page]) window.location.href = routes[page];
};

window.logout = async function() {
    await signOut(auth);
    localStorage.clear();
    window.location.href = 'index.html';
};

console.log('👥 RND Referrals page loaded');