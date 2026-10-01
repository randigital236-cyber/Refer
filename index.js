/* ============================================================
   RND REWARDS — INDEX (Signup / Login / Forgot Password)
   Firebase Auth + Realtime Database
   Referral logic: पूरी तरह जैसा था वैसा ही — कुछ नहीं बदला
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    getAuth,
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
    sendEmailVerification,
    applyActionCode,
    GoogleAuthProvider,
    signInWithPopup,
    onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    getDatabase, ref, set, get, update
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const googleProvider = new GoogleAuthProvider();

const OFFICIAL_DOMAIN = "https://app.randigital.in";
const actionCodeSettings = {
    url: OFFICIAL_DOMAIN + '/dashboard.html',
    handleCodeInApp: true
};

/* ============================================================
   AUTH STATE — Priority to Firebase emailVerified
   ============================================================ */
onAuthStateChanged(auth, async (user) => {
    if (!user) return;

    try {
        const userRef = ref(db, 'users/' + user.uid);
        const snapshot = await get(userRef);
        const userData = snapshot.val();

        const isVerified = user.emailVerified === true;

        if (isVerified) {
            if (userData && userData.emailVerified !== true) {
                await update(userRef, { emailVerified: true });
            }

            localStorage.setItem('userReferralCode', userData?.referralCode || '');
            localStorage.setItem('userName', userData?.name || user.displayName || 'User');
            localStorage.setItem('userId', user.uid);
            localStorage.setItem('userEmail', user.email || '');

            window.location.href = 'dashboard.html';
        } else {
            console.log('Email not verified for:', user.email);
        }
    } catch (error) {
        console.error('Auth state error:', error);
    }
});

/* ============================================================
   NOTIFICATION POPUP
   ============================================================ */
function showNotification(title, message) {
    const container = document.getElementById('notificationContainer');
    const popup = document.createElement('div');
    popup.className = 'notification-popup';
    popup.innerHTML = `
        <i class="fas fa-envelope"></i>
        <div class="notification-content">
            <div class="notification-title">${title}</div>
            <div class="notification-message">${message}</div>
        </div>
        <i class="fas fa-times notification-close" onclick="this.parentElement.remove()"></i>`;
    container.appendChild(popup);
    setTimeout(() => popup.remove(), 8000);
}

/* ============================================================
   REFERRAL CODE FROM URL
   ============================================================ */
function getReferralCodeFromURL() {
    return new URLSearchParams(window.location.search).get('ref');
}

function setReferralCodeFromURL() {
    const refCode = getReferralCodeFromURL();
    if (refCode) {
        document.getElementById('referralCode').value = refCode.toUpperCase();
    }
}

/* ============================================================
   REFERRAL CODE GENERATION — UNCHANGED
   ============================================================ */
function generateReferralCode(userId) {
    return userId.substring(0, 8).toUpperCase();
}

/* ============================================================
   SAVE USER TO DATABASE — UNCHANGED
   Referral logic exactly as original:
   - New user with referrer → gets referralWallet: 1, totalEarned: 1
   - Level-1 referrer → +2 RND
   - Level-2 referrer → +1 RND
   ============================================================ */
async function saveUserToDatabase(user, name, referralCodeFromInput, isEmailVerified = false) {
    const userReferralCode = generateReferralCode(user.uid);
    let referredBy = null, level1Referrer = null, level2Referrer = null;

    if (referralCodeFromInput) {
        const usersRef = ref(db, 'users');
        const snapshot = await get(usersRef);
        const users = snapshot.val();
        if (users) {
            for (let uid in users) {
                if (users[uid].referralCode === referralCodeFromInput.toUpperCase()) {
                    referredBy = uid;
                    if (users[uid].referredBy) {
                        level1Referrer = users[uid].referredBy;
                        if (users[level1Referrer] && users[level1Referrer].referredBy) {
                            level2Referrer = users[level1Referrer].referredBy;
                        }
                    }
                    break;
                }
            }
        }
    }

    const userData = {
        name,
        email: user.email,
        userId: user.uid,
        referralCode: userReferralCode,
        referredBy: referredBy || null,
        referralWallet: referredBy ? 1 : 0,
        spinWallet: 0,
        totalEarned: referredBy ? 1 : 0,
        totalWithdrawn: 0,
        status: 'active',
        emailVerified: isEmailVerified,
        createdAt: new Date().toISOString(),
        socialTasks: {}
    };

    await set(ref(db, 'users/' + user.uid), userData);
    await set(ref(db, 'referrals/' + user.uid), { level1: [], level2: [] });

    if (referredBy) {
        // Level-1 referrer ko +2 RND
        const referrerRef = ref(db, 'users/' + referredBy);
        const referrerSnap = await get(referrerRef);
        if (referrerSnap.exists()) {
            const referrer = referrerSnap.val();
            await update(ref(db, 'users/' + referredBy), {
                referralWallet: (referrer.referralWallet || 0) + 2,
                totalEarned: (referrer.totalEarned || 0) + 2
            });

            const level1Ref = ref(db, 'referrals/' + referredBy + '/level1');
            const level1Data = await get(level1Ref);
            let level1List = level1Data.val() || [];
            if (!level1List.includes(user.uid)) {
                level1List.push(user.uid);
                await set(level1Ref, level1List);
            }
        }

        // Level-2 referrer ko +1 RND
        if (level1Referrer) {
            const level2UserRef = ref(db, 'users/' + level1Referrer);
            const level2Snap = await get(level2UserRef);
            if (level2Snap.exists()) {
                const level2User = level2Snap.val();
                await update(ref(db, 'users/' + level1Referrer), {
                    referralWallet: (level2User.referralWallet || 0) + 1,
                    totalEarned: (level2User.totalEarned || 0) + 1
                });

                const level2ListRef = ref(db, 'referrals/' + level1Referrer + '/level2');
                const level2ListData = await get(level2ListRef);
                let level2List = level2ListData.val() || [];
                if (!level2List.includes(user.uid)) {
                    level2List.push(user.uid);
                    await set(level2ListRef, level2List);
                }
            }
        }
    }

    return userReferralCode;
}

/* ============================================================
   EMAIL VERIFICATION HANDLER
   ============================================================ */
async function handleEmailVerification() {
    try {
        if (window.location.href.includes('mode=verifyEmail')) {
            const actionCode = new URLSearchParams(window.location.search).get('oobCode');
            if (actionCode) {
                const user = auth.currentUser;
                if (user) {
                    await applyActionCode(auth, actionCode);
                    await user.reload();
                    if (user.emailVerified) {
                        await update(ref(db, 'users/' + user.uid), { emailVerified: true });
                        window.location.href = 'dashboard.html';
                    }
                } else {
                    window.location.href = 'dashboard.html';
                }
            }
        }
    } catch (error) {
        console.error("Verification error:", error);
    }
}

/* ============================================================
   NAVIGATION (Card switch)
   ============================================================ */
window.showLogin = function() {
    document.getElementById('signupCard').style.display = 'none';
    document.getElementById('loginCard').style.display = 'block';
    document.getElementById('forgotCard').style.display = 'none';
    document.getElementById('loginMessage').className = 'message';
};

window.showSignup = function() {
    document.getElementById('signupCard').style.display = 'block';
    document.getElementById('loginCard').style.display = 'none';
    document.getElementById('forgotCard').style.display = 'none';
    document.getElementById('message').className = 'message';
    setReferralCodeFromURL();
};

window.showForgotPassword = function() {
    document.getElementById('loginCard').style.display = 'none';
    document.getElementById('forgotCard').style.display = 'block';
    document.getElementById('forgotMessage').className = 'message';
};

setReferralCodeFromURL();

/* ============================================================
   USER-FRIENDLY ERROR MESSAGES
   ============================================================ */
function getUserFriendlyError(errorCode) {
    const errors = {
        'auth/email-already-in-use': 'This email is already registered. Please login.',
        'auth/user-not-found': 'No account found with this email.',
        'auth/wrong-password': 'Incorrect password. Please try again.',
        'auth/weak-password': 'Password must be at least 6 characters.',
        'auth/too-many-requests': 'Too many failed attempts. Please try again later.',
        'auth/network-request-failed': 'Network error. Please check your internet connection.',
        'auth/invalid-email': 'Invalid email address.',
        'auth/user-disabled': 'This account has been disabled.',
        'auth/operation-not-allowed': 'This login method is not enabled.',
        'auth/account-exists-with-different-credential': 'An account exists with this email. Please login with your password.'
    };
    return errors[errorCode] || 'Something went wrong. Please try again.';
}

/* ============================================================
   SIGNUP FORM
   ============================================================ */
document.getElementById('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('name').value;
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    const referralCode = document.getElementById('referralCode').value;
    const messageDiv = document.getElementById('message');
    const btn = document.getElementById('signupBtn');

    messageDiv.className = 'message';

    if (password.length < 6) {
        messageDiv.className = 'message show error';
        messageDiv.innerHTML = 'Password must be at least 6 characters!';
        return;
    }

    btn.classList.add('loading');
    try {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        await sendEmailVerification(user, actionCodeSettings);
        await saveUserToDatabase(user, name, referralCode, false);

        showNotification(
            '📧 Verification Email Sent!',
            `✅ Verification email sent to ${email}!<br><br>📌 Please check your Inbox or Spam folder.<br>🔗 Click the verification link to directly access your dashboard.`
        );

        messageDiv.className = 'message show info';
        messageDiv.innerHTML = `<i class="fas fa-envelope"></i> ✅ Verification email sent!<br><br><strong>📧 Check your email inbox or spam folder</strong><br><br>Click the link in email - Dashboard will open automatically!`;
    } catch (error) {
        messageDiv.className = 'message show error';
        messageDiv.innerHTML = getUserFriendlyError(error.code);
    }
    btn.classList.remove('loading');
});

/* ============================================================
   LOGIN FORM
   ============================================================ */
document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const messageDiv = document.getElementById('loginMessage');
    const btn = document.getElementById('loginBtn');

    messageDiv.className = 'message';
    btn.classList.add('loading');

    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        if (!user.emailVerified) {
            await sendEmailVerification(user, actionCodeSettings);
            messageDiv.className = 'message show error';
            messageDiv.innerHTML = '❌ Email not verified! A new verification link has been sent. Check your email.';
            btn.classList.remove('loading');
            return;
        }

        const userRef = ref(db, 'users/' + user.uid);
        const snapshot = await get(userRef);
        const userData = snapshot.val();

        if (userData && userData.status === 'active') {
            localStorage.setItem('userReferralCode', userData.referralCode || '');
            localStorage.setItem('userName', userData.name || 'User');
            localStorage.setItem('userId', user.uid);
            localStorage.setItem('userEmail', user.email || '');

            messageDiv.className = 'message show success';
            messageDiv.innerHTML = 'Login successful! Redirecting...';
            setTimeout(() => { window.location.href = 'dashboard.html'; }, 1000);
        } else {
            messageDiv.className = 'message show error';
            messageDiv.innerHTML = 'Account is blocked. Contact support.';
        }
    } catch (error) {
        messageDiv.className = 'message show error';
        messageDiv.innerHTML = getUserFriendlyError(error.code);
    }
    btn.classList.remove('loading');
});

/* ============================================================
   GOOGLE SIGN-IN
   ============================================================ */
async function handleGoogleSignIn(isSignup = true) {
    const messageDiv = isSignup
        ? document.getElementById('message')
        : document.getElementById('loginMessage');
    const referralCode = isSignup
        ? document.getElementById('referralCode').value
        : null;
    const btn = isSignup
        ? document.getElementById('googleSignupBtn')
        : document.getElementById('googleLoginBtn');

    messageDiv.className = 'message';
    btn.style.opacity = '0.7';
    btn.style.pointerEvents = 'none';

    try {
        const result = await signInWithPopup(auth, googleProvider);
        const user = result.user;
        const name = user.displayName || user.email.split('@')[0];
        const userRef = ref(db, 'users/' + user.uid);
        const snapshot = await get(userRef);

        if (snapshot.exists()) {
            const userData = snapshot.val();
            if (userData.status === 'active') {
                localStorage.setItem('userReferralCode', userData.referralCode || '');
                localStorage.setItem('userName', userData.name || name);
                localStorage.setItem('userId', user.uid);
                localStorage.setItem('userEmail', user.email || '');

                messageDiv.className = 'message show success';
                messageDiv.innerHTML = 'Login successful! Redirecting...';
                setTimeout(() => { window.location.href = 'dashboard.html'; }, 1500);
            } else {
                messageDiv.className = 'message show error';
                messageDiv.innerHTML = 'Account is blocked. Contact support.';
            }
        } else if (isSignup) {
            const userReferralCode = await saveUserToDatabase(user, name, referralCode, true);
            messageDiv.className = 'message show success';
            messageDiv.innerHTML = 'Account created! Redirecting...';

            localStorage.setItem('userReferralCode', userReferralCode);
            localStorage.setItem('userName', name);
            localStorage.setItem('userId', user.uid);
            localStorage.setItem('userEmail', user.email || '');

            setTimeout(() => { window.location.href = 'dashboard.html'; }, 2500);
        } else {
            messageDiv.className = 'message show error';
            messageDiv.innerHTML = 'No account found. Please sign up first.';
        }
    } catch (error) {
        messageDiv.className = 'message show error';
        messageDiv.innerHTML = getUserFriendlyError(error.code) || 'Google sign in failed. Please try again.';
    }
    btn.style.opacity = '1';
    btn.style.pointerEvents = 'auto';
}

document.getElementById('googleSignupBtn').addEventListener('click', () => handleGoogleSignIn(true));
document.getElementById('googleLoginBtn').addEventListener('click', () => handleGoogleSignIn(false));

/* ============================================================
   FORGOT PASSWORD FORM
   ============================================================ */
document.getElementById('forgotForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgotEmail').value;
    const messageDiv = document.getElementById('forgotMessage');
    const btn = document.getElementById('forgotBtn');

    messageDiv.className = 'message';
    btn.classList.add('loading');

    try {
        await sendPasswordResetEmail(auth, email);
        messageDiv.className = 'message show success';
        messageDiv.innerHTML = 'Password reset email sent! Check your inbox.';
        setTimeout(() => { window.showLogin(); }, 3000);
    } catch (error) {
        messageDiv.className = 'message show error';
        messageDiv.innerHTML = getUserFriendlyError(error.code);
    }
    btn.classList.remove('loading');
});

/* ============================================================
   EMAIL VERIFICATION ON PAGE LOAD
   ============================================================ */
handleEmailVerification();

console.log('🔒 RND Rewards Index loaded');
console.log('✅ Referral logic: UNCHANGED (Level-1: +2 RND, Level-2: +1 RND)');