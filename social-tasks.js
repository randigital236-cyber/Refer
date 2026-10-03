/* ============================================================
   RND REWARDS — SOCIAL TASKS
   - Simple, no firebase storage, no screenshot saving
   - Track "opened" state in-memory only
   - Screenshot uploaded locally (preview) → then Submit
   - Reward: +1 RND to spinWallet + totalEarned
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getDatabase, ref, get, update, onValue
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

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

const SOCIAL_LINKS = {
    facebook: "https://www.facebook.com/profile.php?id=61590396932149",
    twitter: "https://x.com/RanDigitalRND"
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;   // 5 MB

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* ---------- STATE ---------- */
let currentUser = null;
let userData = null;
let unsubUser = null;

/* In-memory only — हर page load पर reset होगा */
const taskState = {
    facebook: { opened: false, hasImage: false },
    twitter:  { opened: false, hasImage: false }
};

/* ============================================================
   OPEN FACEBOOK / TWITTER
   ============================================================ */
window.openFacebookPage = function () {
    if (userData?.socialTasks?.facebook === true) {
        alert('⚠️ आप पहले ही Facebook Task Complete कर चुके हैं!');
        return;
    }

    taskState.facebook.opened = true;
    window.open(SOCIAL_LINKS.facebook, '_blank');

    document.getElementById('fbInfoMsg').style.display = 'block';
    document.getElementById('fbUploadArea').style.display = 'block';

    /* अगर image पहले से है, तो button enabled रहे */
    if (taskState.facebook.hasImage) {
        document.getElementById('fbVerifyBtn').disabled = false;
    }
};

window.openTwitterPage = function () {
    if (userData?.socialTasks?.twitter === true) {
        alert('⚠️ आप पहले ही Twitter Task Complete कर चुके हैं!');
        return;
    }

    taskState.twitter.opened = true;
    window.open(SOCIAL_LINKS.twitter, '_blank');

    document.getElementById('twInfoMsg').style.display = 'block';
    document.getElementById('twUploadArea').style.display = 'block';

    if (taskState.twitter.hasImage) {
        document.getElementById('twVerifyBtn').disabled = false;
    }
};

/* ============================================================
   FILE UPLOAD HANDLER
   ============================================================ */
function setupFileUpload(type) {
    const prefix = type === 'facebook' ? 'fb' : 'tw';
    const fileInput = document.getElementById(`${prefix}File`);
    const previewDiv = document.getElementById(`${prefix}PreviewDiv`);
    const verifyBtn = document.getElementById(`${prefix}VerifyBtn`);

    fileInput.addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;

        if (file.size > MAX_FILE_SIZE) {
            alert('❌ File too large! Max 5 MB.');
            fileInput.value = '';
            return;
        }
        if (!file.type.startsWith('image/')) {
            alert('❌ Please select an image file.');
            fileInput.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = function (ev) {
            previewDiv.innerHTML = `<img src="${ev.target.result}" class="preview-img" alt="Preview">`;
            taskState[type].hasImage = true;

            /* Popup/Open किए बिना upload? — user को warn करें, पर allow करें */
            if (!taskState[type].opened) {
                alert('⚠️ You can upload, but please complete the task on ' +
                      (type === 'facebook' ? 'Facebook' : 'Twitter') + ' first!');
            }

            verifyBtn.disabled = false;
        };
        reader.readAsDataURL(file);
    });
}

/* ============================================================
   VERIFY TASK
   ============================================================ */
async function verifyTask(type) {
    const prefix = type === 'facebook' ? 'fb' : 'tw';
    const verifyBtn = document.getElementById(`${prefix}VerifyBtn`);

    /* --- Already done? --- */
    if (userData?.socialTasks?.[type] === true) {
        alert('⚠️ This task is already completed!');
        return;
    }

    /* --- Screenshot uploaded? --- */
    if (!taskState[type].hasImage) {
        alert('❌ Please select a screenshot first!');
        return;
    }

    /* --- Opened? — चेतावनी दो, पर रोक न लो --- */
    if (!taskState[type].opened) {
        const proceed = confirm(
            '⚠️ आपने "Open" button नहीं दबाया!\n\n' +
            'क्या आपने actually ' + (type === 'facebook' ? 'Facebook' : 'Twitter') + ' पर task पूरा किया है?\n\n' +
            'Yes दबाएँ तो Verify हो जाएगा।'
        );
        if (!proceed) return;
    }

    verifyBtn.disabled = true;
    verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';

    try {
        /* Fresh read — prevent double reward */
        const freshSnap = await get(ref(db, `users/${currentUser.uid}`));
        const freshData = freshSnap.val() || {};

        if (freshData.socialTasks?.[type] === true) {
            alert('⚠️ This task was already completed.');
            return;
        }

        const currentSpin = Number(freshData.spinWallet) || 0;
        const currentEarned = Number(freshData.totalEarned) || 0;

        const updates = {
            [`socialTasks/${type}`]: true,
            [`socialTasks/${type}CompletedAt`]: new Date().toISOString(),
            spinWallet: currentSpin + 1,
            totalEarned: currentEarned + 1
        };

        await update(ref(db, `users/${currentUser.uid}`), updates);

        /* Local state update */
        userData.spinWallet = currentSpin + 1;
        userData.totalEarned = currentEarned + 1;
        if (!userData.socialTasks) userData.socialTasks = {};
        userData.socialTasks[type] = true;

        /* UI update */
        document.getElementById(`${prefix}OpenBtn`).disabled = true;
        document.getElementById(`${prefix}UploadArea`).style.display = 'none';
        document.getElementById(`${prefix}Completed`).style.display = 'block';
        document.getElementById(`${prefix}AlreadyDone`).style.display = 'block';
        document.getElementById(`${prefix}InfoMsg`).style.display = 'none';

        alert(`✅ ${type === 'facebook' ? 'Facebook' : 'Twitter'} Task Verified!\n+1 RND added to your Spin Wallet.`);

    } catch (error) {
        console.error('Verify error:', error);
        alert('❌ Verification failed: ' + error.message);
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = '<i class="fas fa-check-circle"></i> Submit & Verify (+1 RND)';
    }
}

/* ============================================================
   LOAD TASK STATUS
   ============================================================ */
function loadTaskStatus() {
    const tasks = userData?.socialTasks || {};

    /* Facebook */
    if (tasks.facebook === true) {
        document.getElementById('fbOpenBtn').disabled = true;
        document.getElementById('fbUploadArea').style.display = 'none';
        document.getElementById('fbCompleted').style.display = 'block';
        document.getElementById('fbAlreadyDone').style.display = 'block';
        document.getElementById('fbInfoMsg').style.display = 'none';
    } else {
        document.getElementById('fbOpenBtn').disabled = false;
        document.getElementById('fbUploadArea').style.display = 'none';
        document.getElementById('fbCompleted').style.display = 'none';
        document.getElementById('fbAlreadyDone').style.display = 'none';
    }

    /* Twitter */
    if (tasks.twitter === true) {
        document.getElementById('twOpenBtn').disabled = true;
        document.getElementById('twUploadArea').style.display = 'none';
        document.getElementById('twCompleted').style.display = 'block';
        document.getElementById('twAlreadyDone').style.display = 'block';
        document.getElementById('twInfoMsg').style.display = 'none';
    } else {
        document.getElementById('twOpenBtn').disabled = false;
        document.getElementById('twUploadArea').style.display = 'none';
        document.getElementById('twCompleted').style.display = 'none';
        document.getElementById('twAlreadyDone').style.display = 'none';
    }
}

/* ============================================================
   USER LISTENER (real-time)
   ============================================================ */
function attachUserListener(uid) {
    if (unsubUser) unsubUser();
    const userRef = ref(db, `users/${uid}`);
    unsubUser = onValue(userRef, (snap) => {
        if (!snap.exists()) {
            window.location.href = 'index.html';
            return;
        }
        userData = snap.val() || {};
        if (!userData.socialTasks) userData.socialTasks = {};
        loadTaskStatus();
    });
}

/* ============================================================
   AUTH BOOTSTRAP
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    currentUser = user;

    attachUserListener(user.uid);

    /* Setup file upload listeners */
    setupFileUpload('facebook');
    setupFileUpload('twitter');

    /* Setup verify button click handlers */
    document.getElementById('fbVerifyBtn').addEventListener('click', () => verifyTask('facebook'));
    document.getElementById('twVerifyBtn').addEventListener('click', () => verifyTask('twitter'));
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
        await signOut(auth);
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = 'index.html';
    } catch (e) {
        window.location.href = 'index.html';
    }
};

window.addEventListener('beforeunload', () => {
    if (unsubUser) unsubUser();
});

console.log('📱 RND Social Tasks loaded');