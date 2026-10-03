/* ============================================================
   RND REWARDS — SOCIAL TASKS
   - Simple flow: Open → Upload → Verify
   - Rewards: +1 RND to socialTasksWallet + totalEarned
   - Loading screen: data आने तक spinner, फिर hide
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getDatabase, ref, get, update, onValue
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

const taskState = {
    facebook: { opened: false, hasImage: false },
    twitter:  { opened: false, hasImage: false }
};

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

/* Timeout safety */
setTimeout(() => {
    const ls = document.getElementById('loadingScreen');
    if (ls && !ls.classList.contains('hide')) {
        showLoadingError();
    }
}, 8000);

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
   FILE UPLOAD
   ============================================================ */
function setupFileUpload(type) {
    const prefix = type === 'facebook' ? 'fb' : 'tw';
    const fileInput = document.getElementById(`${prefix}File`);
    const previewDiv = document.getElementById(`${prefix}PreviewDiv`);
    const verifyBtn = document.getElementById(`${prefix}VerifyBtn`);

    if (!fileInput) return;

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

    if (userData?.socialTasks?.[type] === true) {
        alert('⚠️ This task is already completed!');
        return;
    }
    if (!taskState[type].hasImage) {
        alert('❌ Please select a screenshot first!');
        return;
    }

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
        const freshSnap = await get(ref(db, `users/${currentUser.uid}`));
        const freshData = freshSnap.val() || {};

        if (freshData.socialTasks?.[type] === true) {
            alert('⚠️ This task was already completed.');
            return;
        }

        const currentTasksWallet = Number(freshData.socialTasksWallet) || 0;
        const currentEarned = Number(freshData.totalEarned) || 0;

        const updates = {
            [`socialTasks/${type}`]: true,
            [`socialTasks/${type}CompletedAt`]: new Date().toISOString(),
            socialTasksWallet: currentTasksWallet + 1,
            totalEarned: currentEarned + 1
        };

        await update(ref(db, `users/${currentUser.uid}`), updates);

        userData.socialTasksWallet = currentTasksWallet + 1;
        userData.totalEarned = currentEarned + 1;
        if (!userData.socialTasks) userData.socialTasks = {};
        userData.socialTasks[type] = true;

        document.getElementById(`${prefix}OpenBtn`).disabled = true;
        document.getElementById(`${prefix}UploadArea`).style.display = 'none';
        document.getElementById(`${prefix}Completed`).style.display = 'block';
        document.getElementById(`${prefix}AlreadyDone`).style.display = 'block';
        document.getElementById(`${prefix}InfoMsg`).style.display = 'none';

        alert(`✅ ${type === 'facebook' ? 'Facebook' : 'Twitter'} Task Verified!\n+1 RND added to your Social Tasks Wallet.`);

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
   USER LISTENER
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

        /* ⭐ Data आया — page दिखाओ */
        loadTaskStatus();
        hideLoadingScreen();
    }, (error) => {
        console.error('DB error:', error);
        showLoadingError();
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

    setupFileUpload('facebook');
    setupFileUpload('twitter');

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

console.log('📱 RND Social Tasks loaded (loading screen enabled)');
