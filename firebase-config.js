// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref, set, get, push, update, child, remove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// Your Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyARtuToUfDsK6EOrqpJ6nBpfSHx2JobWhQ",
  authDomain: "randigital-e7715.firebaseapp.com",
  projectId: "randigital-e7715",
  storageBucket: "randigital-e7715.firebasestorage.app",
  messagingSenderId: "218883279353",
  appId: "1:218883279353:web:cda990aa068f8fdf4d1528",
  measurementId: "G-1V0QQCQQNZ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

export { auth, db, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, ref, set, get, push, update, child };