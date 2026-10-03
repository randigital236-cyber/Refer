/* ============================================================
   RND REWARDS — SPIN WHEEL
   - 6 segments: 0.70, 0.30, 0.12 (duplicated)
   - Cooldown: 8 hours between spins
   - Rewards: spinWallet + totalEarned
   - Loading screen: data आने तक spinner
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getDatabase, ref, get, update
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
const COOLDOWN_MS = 8 * 60 * 60 * 1000;   // 8 hours

const SEGMENTS = [
    { name: "0.70 RND", value: 0.70, color: "#FF6B6B" },
    { name: "0.30 RND", value: 0.30, color: "#4ECDC4" },
    { name: "0.12 RND", value: 0.12, color: "#FFEAA7" },
    { name: "0.70 RND", value: 0.70, color: "#45B7D1" },
    { name: "0.30 RND", value: 0.30, color: "#96CEB4" },
    { name: "0.12 RND", value: 0.12, color: "#DDA0DD" }
];

const PI = Math.PI;
const TAU = 2 * PI;
const segmentAngle = TAU / SEGMENTS.length;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

/* ---------- STATE ---------- */
let currentUser = null;
let userData = null;
let isSpinning = false;
let timerInterval = null;
let dataReady = false;

let canvas = document.getElementById("wheelCanvas");
let ctx = canvas.getContext("2d");
let currentAngle = 0;

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

/* 8-second timeout safety */
setTimeout(() => {
    if (!dataReady) showLoadingError();
}, 8000);

/* ============================================================
   DRAW WHEEL
   ============================================================ */
function drawWheel() {
    const width = canvas.width;
    const height = canvas.height;
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = width / 2 - 10;

    ctx.clearRect(0, 0, width, height);

    /* Segments */
    for (let i = 0; i < SEGMENTS.length; i++) {
        const start = i * segmentAngle + currentAngle;
        const end = start + segmentAngle;

        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.arc(centerX, centerY, radius, start, end);
        ctx.fillStyle = SEGMENTS[i].color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 2;
        ctx.stroke();

        /* Text */
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.rotate(start + segmentAngle / 2);
        ctx.fillStyle = "#1f2937";
        ctx.font = "bold 14px Inter";
        ctx.shadowBlur = 0;
        ctx.textAlign = "right";
        ctx.fillText(SEGMENTS[i].name, radius - 20, 5);
        ctx.restore();
    }

    /* Center circle */
    ctx.beginPath();
    ctx.arc(centerX, centerY, 22, 0, TAU);
    ctx.fillStyle = "white";
    ctx.fill();
    ctx.strokeStyle = "#667eea";
    ctx.lineWidth = 4;
    ctx.stroke();

    /* Inner dot */
    ctx.beginPath();
    ctx.arc(centerX, centerY, 8, 0, TAU);
    ctx.fillStyle = "#667eea";
    ctx.fill();

    /* Pointer */
    ctx.beginPath();
    ctx.moveTo(centerX - 12, 14);
    ctx.lineTo(centerX, 2);
    ctx.lineTo(centerX + 12, 14);
    ctx.closePath();
    ctx.fillStyle = "#dc2626";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
}

/* Initial draw */
drawWheel();

/* ============================================================
   AUTH
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    currentUser = user;
    await loadUserData();
    checkCooldown();

    /* ⭐ Data आया — loading hide करो */
    if (!dataReady) {
        dataReady = true;
        hideLoadingScreen();
    }
});

async function loadUserData() {
    const snap = await get(ref(db, 'users/' + currentUser.uid));
    userData = snap.val();
    if (!userData) {
        userData = { spinWallet: 0, totalEarned: 0, lastSpinTime: 0 };
    }
    if (!userData.lastSpinTime) userData.lastSpinTime = 0;
    document.getElementById('spinWallet').innerText = userData.spinWallet || 0;
}

/* ============================================================
   COOLDOWN
   ============================================================ */
function checkCooldown() {
    const lastSpin = userData.lastSpinTime || 0;
    const now = Date.now();

    if (lastSpin > 0 && (now - lastSpin) < COOLDOWN_MS) {
        const remaining = COOLDOWN_MS - (now - lastSpin);
        startTimer(remaining);
        document.getElementById('spinBtn').disabled = true;
        document.getElementById('timerBadge').style.display = 'inline-flex';
    } else {
        if (timerInterval) clearInterval(timerInterval);
        document.getElementById('spinBtn').disabled = false;
        document.getElementById('timerBadge').style.display = 'none';
    }
}

function startTimer(remainingMs) {
    if (timerInterval) clearInterval(timerInterval);
    let remaining = remainingMs;

    function updateTimer() {
        if (remaining <= 0) {
            clearInterval(timerInterval);
            document.getElementById('spinBtn').disabled = false;
            document.getElementById('timerBadge').style.display = 'none';
            return;
        }

        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        const seconds = Math.floor((remaining % (60 * 1000)) / 1000);

        document.getElementById('countdownTimer').innerHTML =
            `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

        remaining -= 1000;
    }

    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
}

async function updateLastSpinTime() {
    await update(ref(db, 'users/' + currentUser.uid), { lastSpinTime: Date.now() });
    userData.lastSpinTime = Date.now();
}

/* ============================================================
   RESULT MESSAGE
   ============================================================ */
function showResult(message, isWin) {
    const resultDiv = document.getElementById('resultMsg');
    resultDiv.innerHTML = message;
    resultDiv.className = isWin ? 'result win' : 'result lose';
    resultDiv.style.display = 'block';
    setTimeout(() => { resultDiv.style.display = 'none'; }, 4000);
}

/* ============================================================
   START SPIN
   ============================================================ */
window.startSpin = async function () {
    if (isSpinning) return;

    const lastSpin = userData.lastSpinTime || 0;
    const now = Date.now();

    if (lastSpin > 0 && (now - lastSpin) < COOLDOWN_MS) {
        const remaining = COOLDOWN_MS - (now - lastSpin);
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        const seconds = Math.floor((remaining % (60 * 1000)) / 1000);
        showResult(`⏰ आप ${hours} घंटे ${minutes} मिनट ${seconds} सेकंड बाद ही दोबारा Spin कर सकते हैं!`, false);
        return;
    }

    isSpinning = true;
    const spinBtn = document.getElementById('spinBtn');
    spinBtn.disabled = true;
    spinBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Spinning...';

    const randomIndex = Math.floor(Math.random() * SEGMENTS.length);
    const prize = SEGMENTS[randomIndex];

    const spinDuration = 3000;
    const startTime = Date.now();
    const startAngle = currentAngle;
    const fullRotations = 12 * TAU;
    const targetAngle = (randomIndex * segmentAngle) + (segmentAngle / 2);
    const targetRotation = startAngle + fullRotations + targetAngle;

    function animate() {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(1, elapsed / spinDuration);
        const easeOut = 1 - Math.pow(1 - progress, 3.5);

        currentAngle = startAngle + (targetRotation - startAngle) * easeOut;
        drawWheel();

        if (progress < 1) {
            requestAnimationFrame(animate);
        } else {
            currentAngle = targetRotation % TAU;
            drawWheel();

            if (prize.value > 0) {
                const newBalance = (userData.spinWallet || 0) + prize.value;
                const newTotal = (userData.totalEarned || 0) + prize.value;

                update(ref(db, 'users/' + currentUser.uid), {
                    spinWallet: newBalance,
                    totalEarned: newTotal
                }).then(async () => {
                    userData.spinWallet = newBalance;
                    userData.totalEarned = newTotal;
                    document.getElementById('spinWallet').innerText = newBalance.toFixed(2);
                    await updateLastSpinTime();
                    showResult(`🎉 Congratulations! You won ${prize.value.toFixed(2)} RND! 🎉`, true);
                    checkCooldown();
                    spinBtn.disabled = false;
                    spinBtn.innerHTML = '<i class="fas fa-sync-alt"></i> SPIN NOW';
                    isSpinning = false;
                }).catch(err => {
                    console.error(err);
                    showResult("❌ Error! Please try again.", false);
                    spinBtn.disabled = false;
                    spinBtn.innerHTML = '<i class="fas fa-sync-alt"></i> SPIN NOW';
                    isSpinning = false;
                });
            } else {
                updateLastSpinTime().then(() => {
                    showResult("😢 Better luck next time! You got 0 RND.", false);
                    checkCooldown();
                    spinBtn.disabled = false;
                    spinBtn.innerHTML = '<i class="fas fa-sync-alt"></i> SPIN NOW';
                    isSpinning = false;
                });
            }
        }
    }

    animate();
};

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
        if (timerInterval) clearInterval(timerInterval);
        await signOut(auth);
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = 'index.html';
    } catch (e) {
        window.location.href = 'index.html';
    }
};

window.addEventListener('beforeunload', () => {
    if (timerInterval) clearInterval(timerInterval);
});

console.log('🎰 RND Spin Wheel loaded (premium UI)');
