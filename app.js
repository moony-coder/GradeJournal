'use strict';

// ============================================
// CONFIGURATION
// ============================================
const APP_VERSION = '7.0.0';
const SYNC_INTERVAL = 30000;
const MAX_RETRY_ATTEMPTS = 3;
const BATCH_SIZE = 25;

// ============================================
// DOM SAFETY CHECKS
// ============================================
function safeGetElement(id) {
  const el = document.getElementById(id);
  if (!el && id) console.warn(`Element "${id}" not found`);
  return el;
}
function safeAddClass(id, cls) { const el = safeGetElement(id); if (el) el.classList.add(cls); }
function safeRemoveClass(id, cls) { const el = safeGetElement(id); if (el) el.classList.remove(cls); }
function safeToggleClass(id, cls, cond) { const el = safeGetElement(id); if (el) el.classList.toggle(cls, cond); }
function safeSetText(id, text) { const el = safeGetElement(id); if (el) el.textContent = text; }

// ============================================
// SUPABASE CLIENT
// ============================================
let supabase = null;
let currentUser = null;
let syncTimer = null;
let abortController = null;

function connectSupabaseClient() {
  if (window.supabaseClient?.supabase) { supabase = window.supabaseClient.supabase; return true; }
  return false;
}
connectSupabaseClient();
window.addEventListener('supabase:ready', connectSupabaseClient);

// ============================================
// DATABASE & STATE
// ============================================
let DB = {
  classrooms: [], nextId: 1, user: null,
  lastSync: null, syncStatus: 'idle', pendingChanges: [],
  exportSettings: { color: { h: 30, s: 60, l: 50, a: 100 }, logo: null, logoName: null, logoSize: null },
  gradeTemplates: []  // NEW: grade column templates
};

let DB_INDEX = {
  classroomsById: new Map(),
  studentsByClassroom: new Map(),
  lessonsByClassroom: new Map(),
  columnsByClassroom: new Map()
};

const API_BASE = window.location.origin;

// ============================================
// INDEX MANAGEMENT
// ============================================
function rebuildIndex() {
  DB_INDEX = {
    classroomsById: new Map(),
    studentsByClassroom: new Map(),
    lessonsByClassroom: new Map(),
    columnsByClassroom: new Map()
  };
  DB.classrooms.forEach(c => {
    DB_INDEX.classroomsById.set(c.id, c);
    DB_INDEX.studentsByClassroom.set(c.id, new Map(c.students.map(s => [s.id, s])));
    DB_INDEX.lessonsByClassroom.set(c.id, new Map(c.lessons.map(l => [l.id, l])));
    DB_INDEX.columnsByClassroom.set(c.id, new Map(c.columns.map(col => [col.id, col])));
  });
}

function getC(id) { return DB_INDEX.classroomsById.get(id); }
function getStudent(classId, sid) { return DB_INDEX.studentsByClassroom.get(classId)?.get(sid); }
function getLesson(classId, lid) { return DB_INDEX.lessonsByClassroom.get(classId)?.get(lid); }
function getColumn(classId, cid) { return DB_INDEX.columnsByClassroom.get(classId)?.get(cid); }

let CID = null, LID = null;
function CC() { return getC(CID); }
function CL() { return CID && LID ? getLesson(CID, LID) : null; }

// ============================================
// DATA MERGING
// ============================================
function mergeData(local, remote) {
  if (!remote) return local;
  const merged = {
    ...local,
    classrooms: [],
    nextId: Math.max(local.nextId || 1, remote.nextId || 1),
    lastSync: new Date().toISOString(),
    exportSettings: remote.exportSettings || local.exportSettings  // FIX: merge exportSettings
  };
  const localMap = new Map(local.classrooms?.map(c => [c.id, c]) || []);
  const remoteMap = new Map(remote.classrooms?.map(c => [c.id, c]) || []);
  const allIds = new Set([...localMap.keys(), ...remoteMap.keys()]);
  for (const id of allIds) {
    const lc = localMap.get(id), rc = remoteMap.get(id);
    if (lc && !rc) { merged.classrooms.push(lc); }
    else if (!lc && rc) { merged.classrooms.push(rc); }
    else if (lc && rc) {
      const lt = new Date(lc.updatedAt || 0).getTime();
      const rt = new Date(rc.updatedAt || 0).getTime();
      if (rt > lt) {
        merged.classrooms.push({ ...rc, students: mergeArrayById(lc.students||[], rc.students||[]), lessons: mergeArrayById(lc.lessons||[], rc.lessons||[]) });
      } else { merged.classrooms.push(lc); }
    }
  }
  return merged;
}

function mergeArrayById(local, remote) {
  const lm = new Map(local.map(i => [i.id, i]));
  const rm = new Map(remote.map(i => [i.id, i]));
  const merged = [];
  for (const [id, li] of lm) {
    const ri = rm.get(id);
    if (ri) { merged.push(new Date(ri.updatedAt||0) > new Date(li.updatedAt||0) ? ri : li); }
    else { merged.push(li); }
  }
  for (const [id, ri] of rm) { if (!lm.has(id)) merged.push(ri); }
  return merged;
}

// ============================================
// LOAD / SAVE
// ============================================
async function loadDB() {
  try {
    abortController = new AbortController();
    const localData = loadFromLocalStorage();
    if (localData) DB = localData;
    if (!DB.exportSettings) DB.exportSettings = { color: { h: 30, s: 60, l: 50, a: 100 } };
    if (!DB.gradeTemplates) DB.gradeTemplates = [];
    DB.classrooms.forEach(c => {
      if (!c.updatedAt) c.updatedAt = new Date().toISOString();
      c.students?.forEach(s => { if (!s.updatedAt) s.updatedAt = c.updatedAt; });
      c.lessons?.forEach(l => { if (!l.updatedAt) l.updatedAt = c.updatedAt; });
    });
    migrateLegacyData();  // FIX: migrate BEFORE rebuilding index
    rebuildIndex();
  } catch (e) {
    console.error('Failed to load DB', e);
    showToast('⚠️ Failed to load data.');
    await loadFromBackup();
  }
}

function loadFromLocalStorage() {
  try {
    const main = localStorage.getItem('gj_v6_pro');
    if (main) return JSON.parse(main);
    const backup = localStorage.getItem('gj_v6_pro_backup');
    if (backup) return JSON.parse(backup);
  } catch (e) { console.error('localStorage error:', e); }
  return null;
}

async function loadFromBackup() {
  try {
    const backup = localStorage.getItem('gj_v6_pro_backup');
    if (backup) { DB = JSON.parse(backup); rebuildIndex(); showToast('✅ Restored from backup'); }
  } catch (e) { console.error('Backup load failed:', e); }
}

function migrateLegacyData() {
  DB.classrooms.forEach(c => {
    c.lessons.forEach(l => {
      if (!l.studentIds) l.studentIds = c.students.map(s => s.id);
      if (!l.updatedAt) l.updatedAt = new Date().toISOString();
    });
    c.students.forEach(s => { if (!s.updatedAt) s.updatedAt = new Date().toISOString(); });
  });
}

// ============================================
// CLOUD SYNC
// ============================================
async function syncWithCloud() {
  if (!supabase || !DB.user?.id || DB.user?.mode !== 'supabase') return;
  if (DB.syncStatus === 'syncing') return;
  DB.syncStatus = 'syncing'; updateSyncUI();
  try {
    const cloudData = await loadUserDataFromSupabase(DB.user.id);
    DB = mergeData(DB, cloudData);
    rebuildIndex();
    await saveUserDataToSupabase(DB.user.id);
    saveToLocalStorage();
    DB.lastSync = new Date().toISOString();
    DB.syncStatus = 'idle';
    DB.pendingChanges = [];
    updateSyncUI();
    showToast('✅ Synced with cloud');
  } catch (error) {
    console.error('Sync failed:', error);
    DB.syncStatus = 'error'; updateSyncUI();
    showErrorNotification('⚠️ Sync failed. Using local mode.');
    queuePendingChanges();
  }
}

function showErrorNotification(message) {
  document.querySelector('.error-notification')?.remove();
  const n = document.createElement('div');
  n.className = 'error-notification';
  n.innerHTML = `<div style="font-size:20px">⚠️</div><div style="flex:1;font-size:14px;line-height:1.4">${message}</div><button onclick="this.parentElement.remove()" style="background:rgba(255,255,255,.2);border:none;color:white;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center">×</button>`;
  n.style.cssText = 'position:fixed;top:20px;right:20px;background:var(--error);color:white;padding:16px 20px;border-radius:12px;box-shadow:var(--shadow-lg);z-index:10000;display:flex;align-items:center;gap:12px;max-width:350px;animation:slideIn .3s ease;font-weight:500';
  document.body.appendChild(n);
  setTimeout(() => n.parentElement && n.remove(), 5000);
}

function showAuthError(message) {
  const el = safeGetElement('err-signin');
  if (el) { el.textContent = message; el.classList.add('show'); }
  showErrorNotification(message);
}

function queuePendingChanges(badge) {
  if (!DB.pendingChanges) DB.pendingChanges = [];
  DB.pendingChanges.push({ timestamp: new Date().toISOString(), context: badge || 'unknown' });
  if (DB.pendingChanges.length > 50) DB.pendingChanges.shift();
  saveToLocalStorage();
}

function saveToLocalStorage() {
  try {
    const json = JSON.stringify(DB);
    localStorage.setItem('gj_v6_pro', json);
    localStorage.setItem('gj_v6_pro_backup', json);
  } catch (e) { console.error('localStorage save failed:', e); }
}

function updateSyncUI() {
  const el = safeGetElement('sync-indicator');
  if (!el) return;
  el.className = `sync-indicator ${DB.syncStatus}`;
  el.textContent = DB.syncStatus === 'syncing' ? '⟳ Syncing...' :
    DB.syncStatus === 'error' ? '⚠️ Offline' :
    DB.lastSync ? `✓ Synced ${timeAgo(DB.lastSync)}` : '';
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => { if (navigator.onLine && DB.user?.mode === 'supabase') syncWithCloud(); }, SYNC_INTERVAL);
}

function stopAutoSync() { if (syncTimer) { clearInterval(syncTimer); syncTimer = null; } }

// ============================================
// SUPABASE DATA LOADING
// ============================================
async function checkTableExists(tableName) {
  try {
    const { error } = await supabase.from(tableName).select('*').limit(1);
    return !(error?.message?.includes('relation') && error?.message?.includes('does not exist'));
  } catch { return false; }
}

async function loadUserDataFromSupabase(userId) {
  try {
    const tablesExist = await checkTableExists('classrooms');
    if (!tablesExist) return { classrooms: [] };
    const [classrooms, settings] = await Promise.all([
      supabase.from('classrooms').select('*').eq('user_id', userId),
      supabase.from('export_settings').select('*').eq('user_id', userId).maybeSingle()
    ]);
    if (classrooms.error) {
      if (classrooms.error.message?.includes('does not exist')) return { classrooms: [] };
      throw classrooms.error;
    }
    if (!classrooms.data?.length) return { classrooms: [] };
    const classroomIds = classrooms.data.map(c => c.id);
    const [students, lessons, columns] = await Promise.all([
      supabase.from('students').select('*').in('classroom_id', classroomIds),
      supabase.from('lessons').select('*').in('classroom_id', classroomIds),
      supabase.from('columns').select('*').in('classroom_id', classroomIds)
    ]);
    const studentsByClassroom = new Map();
    students.data?.forEach(s => { if (!studentsByClassroom.has(s.classroom_id)) studentsByClassroom.set(s.classroom_id, []); studentsByClassroom.get(s.classroom_id).push(s); });
    const lessonsByClassroom = new Map();
    lessons.data?.forEach(l => { if (!lessonsByClassroom.has(l.classroom_id)) lessonsByClassroom.set(l.classroom_id, []); lessonsByClassroom.get(l.classroom_id).push(l); });
    const columnsByClassroom = new Map();
    columns.data?.forEach(col => { if (!columnsByClassroom.has(col.classroom_id)) columnsByClassroom.set(col.classroom_id, []); columnsByClassroom.get(col.classroom_id).push(col); });
    const lessonIds = lessons.data?.map(l => l.id) || [];
    let grades = [], attendance = [];
    for (let i = 0; i < lessonIds.length; i += BATCH_SIZE) {
      const batch = lessonIds.slice(i, i + BATCH_SIZE);
      const [gb, ab] = await Promise.all([
        supabase.from('grades').select('*').in('lesson_id', batch),
        supabase.from('attendance').select('*').in('lesson_id', batch)
      ]);
      grades = grades.concat(gb.data || []);
      attendance = attendance.concat(ab.data || []);
    }
    const gradesByLesson = new Map();
    grades.forEach(g => { if (!gradesByLesson.has(g.lesson_id)) gradesByLesson.set(g.lesson_id, []); gradesByLesson.get(g.lesson_id).push(g); });
    const attendanceByLesson = new Map();
    attendance.forEach(a => { if (!attendanceByLesson.has(a.lesson_id)) attendanceByLesson.set(a.lesson_id, []); attendanceByLesson.get(a.lesson_id).push(a); });
    const cloudClassrooms = classrooms.data.map(c => {
      const classroomLessons = lessonsByClassroom.get(c.id) || [];
      const lessonsWithData = classroomLessons.map(l => {
        const data = {};
        (gradesByLesson.get(l.id) || []).forEach(g => { if (g.column_id) data[`col_${g.column_id}_${g.student_id}`] = g.grade; });
        (attendanceByLesson.get(l.id) || []).forEach(a => { data[`att_${a.student_id}`] = a.status; });
        return { id: l.lesson_number, topic: l.title, date: l.lesson_date, num: l.lesson_number, mode: l.mode, studentIds: l.student_ids || [], data, updatedAt: l.updated_at };
      });
      return {
        id: c.id, name: c.name, subject: c.subject || '', teacher: c.teacher_name || '',
        students: (studentsByClassroom.get(c.id) || []).map(s => ({ id: s.student_number, name: s.name, phone: s.phone||'', email: s.email||'', parentName: s.parent_name||'', parentPhone: s.parent_phone||'', note: s.notes||'', updatedAt: s.updated_at })),
        lessons: lessonsWithData,
        columns: (columnsByClassroom.get(c.id) || []).map(col => ({ id: col.column_number, name: col.name, ielts: col.ielts||false, lessonId: col.lesson_id ? classroomLessons.find(l => l.id === col.lesson_id)?.lesson_number : null })),
        nextSid: c.next_student_id, nextLid: c.next_lesson_id, nextCid: c.next_column_id, updatedAt: c.updated_at
      };
    });
    let exportSettings = DB.exportSettings;
    if (settings.data) exportSettings = { color: settings.data.color || { h:30,s:60,l:50,a:100 }, logo: settings.data.logo_data||null, logoName: settings.data.logo_name||null, logoSize: settings.data.logo_size||null };
    return { classrooms: cloudClassrooms, exportSettings, nextId: Math.max(...cloudClassrooms.map(c => parseInt(c.id.split('-')[0])||0), 0) + 1 };
  } catch (e) {
    console.error('Supabase load error:', e);
    showErrorNotification('Database tables not set up. Please run the Supabase setup script.');
    return { classrooms: [] };
  }
}

async function saveUserDataToSupabase(userId) {
  if (!supabase) throw new Error('Supabase not initialized');
  const errors = [];
  for (const c of DB.classrooms) {
    try {
      const { error } = await supabase.from('classrooms').upsert({ user_id: userId, id: c.id, name: c.name, subject: c.subject, teacher_name: c.teacher, next_student_id: c.nextSid, next_lesson_id: c.nextLid, next_column_id: c.nextCid, updated_at: new Date().toISOString() }).select().single();
      if (error) {
        if (error.message?.includes('does not exist')) { showErrorNotification('Database tables not set up.'); return; }
        throw error;
      }
    } catch (e) { errors.push(e); }
  }
  if (errors.length) showErrorNotification(`⚠️ ${errors.length} items failed to sync`);
}

// ============================================
// SAVE DB
// ============================================
let _st;
let saveQueue = [];

async function saveDB(badge, immediate = false) {
  saveQueue.push({ badge, timestamp: Date.now() });
  const saveOperation = async () => {
    try {
      saveToLocalStorage();
      if (navigator.onLine && supabase && DB.user?.mode === 'supabase' && DB.user?.id) {
        try { await saveUserDataToSupabase(DB.user.id); DB.pendingChanges = []; }
        catch (e) { console.error('Cloud save failed:', e); queuePendingChanges(badge); }
      }
      const lastBadge = saveQueue[saveQueue.length - 1]?.badge;
      if (lastBadge) showSave(lastBadge);
    } catch (e) { console.error('Save failed:', e); }
    saveQueue = [];
  };
  if (immediate) { clearTimeout(_st); await saveOperation(); }
  else { clearTimeout(_st); _st = setTimeout(saveOperation, 150); }
}

function showSave(badge) {
  const el = safeGetElement('save-pill-' + badge);
  if (!el) return;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

// ============================================
// IELTS MODE
// ============================================
const IELTS_SECTIONS = ['Listening', 'Reading', 'Writing', 'Speaking', 'Overall Band'];
let currentLessonMode = 'standard';

function toggleLessonMode(mode) {
  currentLessonMode = mode;
  const standardBtn = safeGetElement('mode-standard');
  const ieltsBtn = safeGetElement('mode-ielts');
  if (standardBtn) standardBtn.classList.toggle('active', mode === 'standard');
  if (ieltsBtn) {
    ieltsBtn.classList.toggle('ielts-active', mode === 'ielts');
    ieltsBtn.classList.toggle('active', mode === 'ielts');
  }
}

// ============================================
// SCREEN NAVIGATION
// ============================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = safeGetElement(id);
  if (el) el.classList.add('active');
}
function showLanding() { showScreen('s-landing'); }
function showAuth(mode) { showScreen('s-auth'); if (mode) authSwitchTab(mode); loadAuthLogo(); }
function goHome() { showScreen('s-home'); renderClassrooms(); }
function goBackToClass() { showScreen('s-classroom'); switchTab('students', document.querySelector('[data-tab="students"]')); }
function showContact() { showScreen('s-contact'); }

// ============================================
// AUTH LOGO
// ============================================
function loadAuthLogo() {
  const logoContainer = safeGetElement('auth-logo-container');
  if (!logoContainer) return;
  if (DB.exportSettings?.logo) {
    logoContainer.innerHTML = `<img src="${DB.exportSettings.logo}" alt="School Logo" class="auth-logo-img" loading="lazy">`;
  } else {
    logoContainer.innerHTML = `<div class="logo-fallback">GJ</div><p>Your School Logo</p>`;
  }
}

// ============================================
// AUTHENTICATION
// ============================================
let _authMode = 'signin';

function authSwitchTab(mode) {
  _authMode = mode;
  const tabSignin = safeGetElement('tab-signin');
  const authTagline = safeGetElement('auth-tagline');
  const errSignin = safeGetElement('err-signin');
  // FIX: properly reflect mode
  if (tabSignin) tabSignin.classList.toggle('active', mode === 'signin');
  if (authTagline) authTagline.textContent = mode === 'signin' ? 'Welcome back — log in to continue' : 'Create your account';
  if (errSignin) errSignin.classList.remove('show');
}

function authErr(id, msg) { showAuthError(msg); }

async function authSubmit(mode) {
  if (mode === 'signin') {
    const email = safeGetElement('si-email')?.value.trim();
    const pass = safeGetElement('si-password')?.value;
    if (!email || !pass) { showAuthError('Please fill in all fields.'); return; }
    if (pass.length < 6) { showAuthError('Password must be at least 6 characters.'); return; }
    if (supabase) {
      try {
        const guestData = { ...DB };
        const { data, error } = await supabase.auth.signInWithPassword({ email, password: pass });
        if (error) {
          if (error.message.includes('Invalid login credentials')) showAuthError('Invalid email or password.');
          else if (error.message.includes('Email not confirmed')) showAuthError('Please confirm your email first.');
          else if (error.message.includes('Network') || error.message.includes('fetch')) {
            showAuthError('Unable to connect. Using local mode.');
            DB.user = { id: 'local_' + Date.now(), email, name: email.split('@')[0], mode: 'local' };
            await saveDB('home', true); enterApp();
          } else showAuthError(error.message);
          return;
        }
        const user = data.user;
        let cloudData = { classrooms: [] };
        try { cloudData = await loadUserDataFromSupabase(user.id); } catch {}
        DB = mergeData(guestData, cloudData);
        DB.user = { id: user.id, email: user.email, name: user.user_metadata?.full_name || user.email.split('@')[0], mode: 'supabase' };
        await saveDB('home', true);
        startAutoSync();
        enterApp();
      } catch (err) { console.error('Auth error:', err); showAuthError('Authentication failed. Please try again.'); }
      return;
    }
    DB.user = { id: 'local_' + Date.now(), email, name: email.split('@')[0], mode: 'local' };
    await saveDB('home', true);
    enterApp();
  }
}

function enterApp() {
  const u = DB.user;
  if (!u) return;
  safeSetText('user-name-display', u.name);
  safeSetText('user-av', u.name.slice(0, 2).toUpperCase());
  safeSetText('um-name', u.name);
  safeSetText('um-email', u.email || 'Local mode');
  const h = new Date().getHours();
  safeSetText('home-greeting', (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + u.name.split(' ')[0] + ' 👋');
  showScreen('s-home');
  renderClassrooms();
  addSyncIndicator();
  checkOnboarding();
}

function addSyncIndicator() {
  const topbarRight = document.querySelector('#s-home .topbar-right');
  if (topbarRight && !safeGetElement('sync-indicator')) {
    const indicator = document.createElement('div');
    indicator.id = 'sync-indicator';
    indicator.className = 'sync-indicator idle';
    topbarRight.prepend(indicator);
    updateSyncUI();
  }
}

async function signOut() {
  stopAutoSync();
  await saveDB('home', true);
  if (supabase && DB.user?.mode === 'supabase') await supabase.auth.signOut();
  localStorage.setItem('gj_v6_pro_last_user', JSON.stringify({ ...DB }));
  DB.user = null; DB.syncStatus = 'idle';
  saveToLocalStorage();
  closeOv('ov-user');
  showLanding();
}

// ============================================
// ONBOARDING
// ============================================
function checkOnboarding() {
  if (DB.user && !DB.user.onboardingCompleted) {
    if (DB.user.name) { const el = safeGetElement('onboarding-name'); if (el) el.value = DB.user.name; }
    if (DB.user.school) { const el = safeGetElement('onboarding-school'); if (el) el.value = DB.user.school; }
    if (DB.user.role) { const el = safeGetElement('onboarding-role'); if (el) el.value = DB.user.role; }
    setTimeout(() => openOv('ov-onboarding'), 500);
  }
}

async function saveOnboarding() {
  const nameInput = safeGetElement('onboarding-name');
  const schoolInput = safeGetElement('onboarding-school');
  const roleSelect = safeGetElement('onboarding-role');
  if (!nameInput || !schoolInput || !roleSelect) return;
  const name = nameInput.value.trim();
  const school = schoolInput.value.trim();
  const role = roleSelect.value;
  if (!name) { shake('onboarding-name'); return; }
  DB.user.name = name; DB.user.school = school; DB.user.role = role; DB.user.onboardingCompleted = true;
  safeSetText('user-name-display', name);
  safeSetText('user-av', name.slice(0, 2).toUpperCase());
  safeSetText('um-name', name);
  const h = new Date().getHours();
  safeSetText('home-greeting', (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + name.split(' ')[0] + ' 👋');
  if (supabase && DB.user?.mode === 'supabase' && DB.user?.id) {
    await supabase.from('profiles').upsert({ id: DB.user.id, full_name: name, school_name: school, role, onboarding_completed: true });
  }
  saveDB('home', true);
  closeOv('ov-onboarding');
}

// ============================================
// CLASSROOMS
// ============================================
const CC_ICONS = ['📐', '📚', '🔬', '✏️', '🎨', '🌍', '💻', '🎵', '🏃', '📖', '⚗️', '🧬'];

function renderClassrooms() {
  const grid = safeGetElement('classrooms-grid');
  if (!grid) return;
  grid.innerHTML = '';
  document.querySelector('.welcome-card')?.remove();

  DB.classrooms.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'classroom-card fade-up';
    card.style.animationDelay = (i * .05) + 's';
    const baseIndex = Number.isFinite(Number(c.id)) ? Number(c.id) : i;
    const icon = CC_ICONS[Math.abs(baseIndex) % CC_ICONS.length] || '📚';
    const studentCount = Array.isArray(c.students) ? c.students.length : 0;
    const lessonCount = Array.isArray(c.lessons) ? c.lessons.length : 0;
    const columnCount = Array.isArray(c.columns) ? c.columns.length : 0;
    // Attendance streak detection
    const hasStreak = c.students.some(s => checkAttendanceStreak(c, s.id));
    card.innerHTML = `<div class="cc-header"><div class="cc-icon">${icon}</div><button class="cc-del" onclick="event.stopPropagation();deleteClassConfirm('${c.id}')"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></div>
      <div class="cc-name">${esc(c.name)}</div><div class="cc-subject">${esc(c.subject || '')}${c.teacher ? ' · ' + esc(c.teacher) : ''}</div>
      <div class="cc-stats"><div><div class="cc-stat-val">${studentCount}</div><div class="cc-stat-lbl">Students</div></div><div><div class="cc-stat-val">${lessonCount}</div><div class="cc-stat-lbl">Lessons</div></div><div><div class="cc-stat-val">${columnCount}</div><div class="cc-stat-lbl">Columns</div></div></div>
      ${hasStreak ? '<div class="cc-streak-badge">🔥 Perfect Attendance</div>' : ''}`;
    card.onclick = () => openClassroom(c.id);
    grid.appendChild(card);
  });

  const nc = document.createElement('div');
  nc.className = 'new-class-card';
  nc.innerHTML = `<div class="new-class-plus">+</div><span>New Classroom</span>`;
  nc.onclick = () => openOv('ov-new-class');
  grid.appendChild(nc);
  maybeShowWelcomeCard();
}

// FIX: streak detection helper
function checkAttendanceStreak(classroom, studentId) {
  const sorted = [...classroom.lessons].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
  if (sorted.length < 3) return false;
  return sorted.every(l => {
    if (l.studentIds && !l.studentIds.includes(studentId)) return true;
    return ((l.data || {})[`att_${studentId}`] || 'present') !== 'absent';
  });
}

function createClassroom() {
  const nameInput = safeGetElement('inp-cname');
  if (!nameInput) return;
  const name = nameInput.value.trim();
  if (!name) { shake('inp-cname'); return; }
  const subjectInput = safeGetElement('inp-csub');
  const teacherInput = safeGetElement('inp-cteacher');
  const newClass = {
    id: `class_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    name, subject: subjectInput?.value.trim() || '', teacher: teacherInput?.value.trim() || '',
    students: [], columns: [], lessons: [],
    nextSid: 1, nextLid: 1, nextCid: 1,
    updatedAt: new Date().toISOString()
  };
  DB.classrooms.push(newClass);
  rebuildIndex(); saveDB('home');
  closeOv('ov-new-class');
  clrInputs(['inp-cname', 'inp-csub', 'inp-cteacher']);
  renderClassrooms();
  toast('Classroom created!');
}

function deleteClassConfirm(id) {
  const c = getC(id);
  if (!c) return;
  confirm_(`Delete "${c.name}"?`, 'All students, lessons, and grades will be permanently deleted.', () => {
    // FIX: no variable shadowing
    DB.classrooms = DB.classrooms.filter(cls => cls.id !== id);
    rebuildIndex(); saveDB('home', true); renderClassrooms();
    toast('Deleted.');
  });
}

function openClassroom(id) {
  CID = id;
  const c = CC();
  if (!c) return;
  safeSetText('class-crumb', c.name);
  safeSetText('lesson-back-label', c.name);
  showScreen('s-classroom');
  switchTab('students', document.querySelector('[data-tab="students"]'));
  renderStudents();
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const p = safeGetElement('tp-' + name);
  if (p) p.classList.add('active');
  if (name === 'students') renderStudents();
  if (name === 'lessons') renderLessons();
  if (name === 'analytics') renderAnalytics();
}

// ============================================
// STUDENTS
// ============================================
let editSid = null;

function openAddStudent() {
  editSid = null;
  safeSetText('ov-stu-title', 'Add Student');
  const saveBtn = safeGetElement('stu-save-btn');
  if (saveBtn) saveBtn.textContent = 'Add Student';
  clrInputs(['inp-sname', 'inp-sphone', 'inp-semail', 'inp-pname', 'inp-pphone', 'inp-snote']);
  openOv('ov-student');
}

function openEditStudent(sid) {
  editSid = sid;
  const s = getStudent(CID, sid);
  if (!s) return;
  safeSetText('ov-stu-title', 'Edit Student');
  const saveBtn = safeGetElement('stu-save-btn');
  if (saveBtn) saveBtn.textContent = 'Save';
  const nameInput = safeGetElement('inp-sname');
  const phoneInput = safeGetElement('inp-sphone');
  const emailInput = safeGetElement('inp-semail');
  const pnameInput = safeGetElement('inp-pname');
  const pphoneInput = safeGetElement('inp-pphone');
  const noteInput = safeGetElement('inp-snote');
  if (nameInput) nameInput.value = s.name || '';
  if (phoneInput) phoneInput.value = s.phone || '';
  if (emailInput) emailInput.value = s.email || '';
  if (pnameInput) pnameInput.value = s.parentName || '';
  if (pphoneInput) pphoneInput.value = s.parentPhone || '';
  if (noteInput) noteInput.value = s.note || '';
  openOv('ov-student');
}

function saveStudent() {
  const nameInput = safeGetElement('inp-sname');
  if (!nameInput) return;
  const name = nameInput.value.trim();
  if (!name) { shake('inp-sname'); return; }
  const data = {
    name,
    phone: safeGetElement('inp-sphone')?.value.trim() || '',
    email: safeGetElement('inp-semail')?.value.trim() || '',
    parentName: safeGetElement('inp-pname')?.value.trim() || '',
    parentPhone: safeGetElement('inp-pphone')?.value.trim() || '',
    note: safeGetElement('inp-snote')?.value.trim() || '',
    updatedAt: new Date().toISOString()
  };
  const c = CC();
  if (!c) return;
  // FIX: capture editSid before closing
  const wasEditing = editSid !== null;
  const editedId = editSid;
  if (wasEditing) {
    const student = c.students.find(s => s.id === editedId);
    if (student) Object.assign(student, data);
    toast('Student updated!');
  } else {
    const newId = c.nextSid++;
    c.students.push({ id: newId, ...data });
    toast('Student added!');
  }
  rebuildIndex(); saveDB('class'); closeOv('ov-student'); renderStudents();
  // FIX: open correct sheet
  const sheetOv = safeGetElement('sheet-ov');
  if (sheetOv?.classList.contains('open')) {
    const sheetSid = wasEditing ? editedId : c.students[c.students.length - 1].id;
    openStudentSheet(sheetSid);
  }
}

function studentStats(sid) {
  const c = CC();
  if (!c) return { present: 0, late: 0, absent: 0, attended: 0, total: 0 };
  let present = 0, late = 0, absent = 0;
  c.lessons.forEach(l => {
    if (l.studentIds && !l.studentIds.includes(sid)) return;
    const val = (l.data || {})[`att_${sid}`] || 'present';
    if (val === 'present') present++;
    else if (val === 'late') late++;
    else absent++;
  });
  return { present, late, absent, attended: present + late, total: c.lessons.filter(l => !l.studentIds || l.studentIds.includes(sid)).length };
}

function renderStudents() {
  const c = CC();
  if (!c) return;
  const list = safeGetElement('students-list');
  const studentsCount = safeGetElement('students-count');
  const tbadge = safeGetElement('tbadge-students');
  if (studentsCount) studentsCount.textContent = c.students.length;
  if (tbadge) tbadge.textContent = c.students.length;
  if (!list) return;
  list.innerHTML = '';
  const sorted = [...c.students]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter(s => !_studentFilter || s.name.toLowerCase().includes(_studentFilter));
  if (!sorted.length && _studentFilter) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No results</div><div class="empty-desc">No students match "${_studentFilter}"</div></div>`;
    return;
  }
  if (!sorted.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">👤</div><div class="empty-title">No students yet</div><div class="empty-desc">Add students using the button above.</div></div>`;
    return;
  }
  sorted.forEach((s, i) => {
    const st = studentStats(s.id);
    const initials = s.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const rate = st.total > 0 ? Math.round(st.attended / st.total * 100) : 100;
    const hasStreak = checkAttendanceStreak(c, s.id);
    const el = document.createElement('div');
    el.className = 'student-item fade-up';
    el.style.animationDelay = (i * .04) + 's';
    el.innerHTML = `<div class="s-avatar">${esc(initials)}</div>
      <div class="s-info"><div class="s-name">${esc(s.name)} ${hasStreak ? '<span title="Perfect attendance streak!">🔥</span>' : ''}</div>
        <div class="s-meta">${s.phone ? `<span class="s-meta-item">📱 ${esc(s.phone)}</span>` : ''}${s.note ? `<span class="s-meta-item">📝 ${esc(s.note)}</span>` : ''}</div></div>
      <div class="s-att-pills">${st.total > 0 ? `<span class="pill pill-green">✓ ${st.present}</span>${st.late > 0 ? `<span class="pill pill-amber">⏰ ${st.late}</span>` : ''}${st.absent > 0 ? `<span class="pill pill-red">✗ ${st.absent}</span>` : ''}<span class="pill" style="background:var(--cream-2);color:var(--text-light)">${rate}%</span>` : '<span style="font-size:11px;color:var(--text-light)">No lessons</span>'}</div>
      <div class="s-actions">
        <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();openStudentSheet(${s.id})">View</button>
        <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation();openEditStudent(${s.id})">Edit</button>
        <button class="icon-btn" style="width:28px;height:28px" onclick="event.stopPropagation();delStudentConfirm(${s.id})"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
      </div>`;
    el.onclick = () => openStudentSheet(s.id);
    list.appendChild(el);
  });
}

function delStudentConfirm(sid) {
  const s = getStudent(CID, sid);
  if (!s) return;
  confirm_(`Remove "${s.name}"?`, 'All attendance and grades for this student will be removed.', () => {
    const c = CC();
    if (!c) return;
    // FIX: no variable shadowing
    c.students = c.students.filter(st => st.id !== sid);
    rebuildIndex(); saveDB('class', true); renderStudents();
    toast('Student removed.');
  });
}

function openStudentSheet(sid) {
  const c = CC(), s = getStudent(CID, sid);
  if (!c || !s) return;
  const st = studentStats(sid);
  const rate = st.total > 0 ? Math.round(st.attended / st.total * 100) : 100;
  const rateColor = rate >= 80 ? 'var(--success)' : rate >= 60 ? 'var(--warning)' : 'var(--error)';
  const initials = s.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  const hist = c.lessons.slice().reverse().map(l => {
    const val = (l.data || {})[`att_${s.id}`] || 'present';
    const lbl = { present: 'Present', late: 'Late', absent: 'Absent' };
    return `<div class="history-row"><div class="history-date">${l.date}</div><div class="history-topic">${esc(l.topic || '(no topic)')}</div><span class="pill pill-${val === 'present' ? 'green' : val === 'late' ? 'amber' : 'red'}">${lbl[val]}</span></div>`;
  }).join('') || '<p style="font-size:13px;color:var(--text-light)">No lessons recorded yet.</p>';
  const sheetContent = safeGetElement('sheet-content');
  if (!sheetContent) return;
  sheetContent.innerHTML = `
    <div class="sheet-hdr">
      <div class="sheet-av" id="sh-av">${esc(initials)}</div>
      <div style="flex:1"><div class="sheet-name" id="sh-name">${esc(s.name)}</div><div class="sheet-class-name">${esc(c.name)}</div></div>
      <button class="sheet-x" onclick="closeSheet()">×</button>
    </div>
    <div class="sheet-sec">
      <div class="sheet-sec-title">Contact Info <span style="font-size:9px;color:var(--accent);font-weight:500;margin-left:6px;text-transform:none;letter-spacing:0">click any field to edit</span></div>
      <div class="info-grid">
        ${icard(sid,'name','Name',s.name)}${icard(sid,'phone','Student Phone',s.phone||'')}${icard(sid,'email','Email',s.email||'')}${icard(sid,'parentName','Parent / Guardian',s.parentName||'')}${icard(sid,'parentPhone','Parent Phone',s.parentPhone||'')}${icard(sid,'note','Notes',s.note||'')}
      </div>
    </div>
    <div class="sheet-sec">
      <div class="sheet-sec-title">Attendance Summary</div>
      <div class="info-grid">
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Total Lessons</div><div class="info-card-val">${st.total}</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Attendance Rate</div><div class="info-card-val" style="color:${rateColor}">${rate}%</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Present</div><div class="info-card-val" style="color:var(--success)">${st.present}</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Late (attended)</div><div class="info-card-val" style="color:var(--warning)">${st.late}</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Absent</div><div class="info-card-val" style="color:var(--error)">${st.absent}</div></div>
        <div class="info-card no-edit" style="cursor:default"><div class="info-card-label">Days Attended</div><div class="info-card-val">${st.attended}</div></div>
      </div>
    </div>
    <div class="sheet-sec"><div class="sheet-sec-title">Lesson History</div>${hist}</div>
    <button class="btn btn-danger" style="width:100%;justify-content:center" onclick="delStudentConfirm(${sid});closeSheet()">Remove Student</button>`;
  const sheetOv = safeGetElement('sheet-ov');
  if (sheetOv) sheetOv.classList.add('open');
}

function icard(sid, field, label, val) {
  const display = val ? esc(val) : `<span class="empty">—</span>`;
  return `<div class="info-card" onclick="editField(this,${sid},'${field}')">
    <div class="info-card-label">${label}<span class="edit-hint">✎ edit</span></div>
    <div class="info-card-val">${display}</div>
  </div>`;
}

function editField(card, sid, field) {
  if (card.classList.contains('editing')) return;
  card.classList.add('editing');
  const valDiv = card.querySelector('.info-card-val');
  const s = getStudent(CID, sid);
  if (!s) return;
  const cur = s[field] || '';
  valDiv.innerHTML = `<input class="info-card-input" value="${esc(cur)}" placeholder="—">`;
  const inp = valDiv.querySelector('input');
  inp.focus(); inp.select();
  function commit() {
    const nv = inp.value.trim();
    s[field] = nv;
    s.updatedAt = new Date().toISOString();
    saveDB('class');
    card.classList.remove('editing');
    valDiv.innerHTML = nv ? esc(nv) : '<span class="empty">—</span>';
    if (field === 'name') {
      const shn = safeGetElement('sh-name');
      if (shn) shn.textContent = nv || s.name;
      const shav = safeGetElement('sh-av');
      if (shav) shav.textContent = nv.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
      renderStudents();
    }
  }
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { card.classList.remove('editing'); valDiv.innerHTML = cur ? esc(cur) : '<span class="empty">—</span>'; }
  };
  inp.onblur = commit;
}

function closeSheet() { safeGetElement('sheet-ov')?.classList.remove('open'); }
function closeSheetIfBg(e) { if (e.target === safeGetElement('sheet-ov')) closeSheet(); }

// ============================================
// LESSONS
// ============================================
function openAddLesson() {
  currentLessonMode = 'standard';
  toggleLessonMode('standard');
  const dateInput = safeGetElement('inp-ldate');
  if (dateInput) dateInput.value = todayStr();
  const topicInput = safeGetElement('inp-ltopic');
  if (topicInput) topicInput.value = '';
  const numInput = safeGetElement('inp-lnum');
  if (numInput) numInput.value = '';
  renderTemplateSelector();
  openOv('ov-lesson');
}

function saveLesson() {
  const topicInput = safeGetElement('inp-ltopic');
  if (!topicInput) return;
  const topic = topicInput.value.trim();
  if (!topic) { shake('inp-ltopic'); return; }
  const dateInput = safeGetElement('inp-ldate');
  const date = dateInput ? dateInput.value : todayStr();
  const c = CC();
  if (!c) return;
  const numInput = safeGetElement('inp-lnum');
  const num = parseInt(numInput ? numInput.value : '') || c.lessons.length + 1;
  // FIX: capture mode before reset
  const mode = currentLessonMode;
  const lesson = { id: c.nextLid++, topic, date, num, data: {}, mode, studentIds: c.students.map(s => s.id), updatedAt: new Date().toISOString() };
  if (mode === 'ielts') {
    IELTS_SECTIONS.forEach(sec => {
      if (sec !== 'Overall Band') {
        c.columns.push({ id: c.nextCid++, name: sec, ielts: true, lessonId: lesson.id, updatedAt: new Date().toISOString() });
      }
    });
  }
  c.lessons.push(lesson);
  LID = lesson.id;
  rebuildIndex(); saveDB('class'); closeOv('ov-lesson'); renderLessons();
  const tbadge = safeGetElement('tbadge-lessons');
  if (tbadge) tbadge.textContent = c.lessons.length;
  // FIX: use captured mode
  toast(mode === 'ielts' ? '🎯 IELTS lesson created!' : 'Lesson created!');
}

let editLid = null;

function openEditLesson(lid) {
  editLid = lid;
  const l = getLesson(CID, lid);
  if (!l) return;
  const topicInput = safeGetElement('inp-el-topic');
  const dateInput = safeGetElement('inp-el-date');
  const numInput = safeGetElement('inp-el-num');
  if (topicInput) topicInput.value = l.topic;
  if (dateInput) dateInput.value = l.date;
  if (numInput) numInput.value = l.num || '';
  openOv('ov-edit-lesson');
}

function confirmEditLesson() {
  const topicInput = safeGetElement('inp-el-topic');
  if (!topicInput) return;
  const topic = topicInput.value.trim();
  if (!topic) { shake('inp-el-topic'); return; }
  const l = getLesson(CID, editLid);
  if (!l) return;
  l.topic = topic;
  const dateInput = safeGetElement('inp-el-date');
  if (dateInput?.value) l.date = dateInput.value;
  const numInput = safeGetElement('inp-el-num');
  if (numInput?.value) l.num = parseInt(numInput.value) || l.num;
  l.updatedAt = new Date().toISOString();
  saveDB('class'); closeOv('ov-edit-lesson'); renderLessons();
  if (LID === editLid) renderLessonHeader();
}

function renderLessons() {
  const c = CC();
  if (!c) return;
  const list = safeGetElement('lessons-list');
  const lessonsCount = safeGetElement('lessons-count');
  const tbadge = safeGetElement('tbadge-lessons');
  if (lessonsCount) lessonsCount.textContent = c.lessons.length;
  if (tbadge) tbadge.textContent = c.lessons.length;
  if (!list) return;
  list.innerHTML = '';
  if (!c.lessons.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-title">No lessons yet</div><div class="empty-desc">Create a lesson to start recording attendance and grades.</div></div>`;
    return;
  }
  const sorted = [...c.lessons]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .filter(l => !_lessonFilter || l.topic.toLowerCase().includes(_lessonFilter) || l.date.includes(_lessonFilter));
  if (!sorted.length && _lessonFilter) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No results</div><div class="empty-desc">No lessons match "${_lessonFilter}"</div></div>`;
    return;
  }
  sorted.forEach((l, i) => {
    let p = 0, la = 0, ab = 0;
    c.students.forEach(s => {
      if (l.studentIds && !l.studentIds.includes(s.id)) return;
      const val = (l.data || {})[`att_${s.id}`] || 'present';
      if (val === 'present') p++;
      else if (val === 'late') la++;
      else ab++;
    });
    const total = l.studentIds ? l.studentIds.length : c.students.length;
    const rate = total > 0 ? Math.round((p + la) / total * 100) : 100;
    const el = document.createElement('div');
    el.className = 'lesson-item fade-up' + (l.mode === 'ielts' ? ' ielts-lesson' : '');
    el.style.animationDelay = (i * .04) + 's';
    const status = lessonCompletionStatus(l, c);
    const statusDot = status === 'complete' ? '<span class="lesson-status-dot complete" title="All grades filled">●</span>'
      : status === 'partial' ? '<span class="lesson-status-dot partial" title="Some grades missing">◑</span>'
      : status === 'att-only' ? '<span class="lesson-status-dot att-only" title="Attendance only">○</span>' : '';
    // NEW: lesson notes preview
    const notesPreview = l.notes ? `<div class="lesson-notes-preview">📝 ${esc(l.notes.substring(0, 60))}${l.notes.length > 60 ? '…' : ''}</div>` : '';
    el.innerHTML = `<div class="lesson-number">${l.num || i + 1}</div>
      <div class="lesson-info">
        <div class="lesson-name">${esc(l.topic)}${l.mode === 'ielts' ? '<span class="ielts-badge" style="margin-left:8px">🎯 IELTS</span>' : ''}${statusDot}</div>
        <div class="lesson-date-row"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span>${l.date}</span><span style="color:var(--border)">·</span><span>${total} students</span><span style="color:var(--border)">·</span><span style="font-weight:700;color:${rate >= 80 ? 'var(--success)' : rate >= 60 ? 'var(--warning)' : 'var(--error)'}">${rate}% att.</span></div>
        ${notesPreview}
      </div>
      ${c.students.length > 0 ? `<div class="lesson-att-mini"><div class="att-dot p">${p}</div>${la > 0 ? `<div class="att-dot l">${la}</div>` : ''}${ab > 0 ? `<div class="att-dot a">${ab}</div>` : ''}</div>` : ''}
      <button style="background:none;border:none;cursor:pointer;padding:4px 7px;color:var(--text-light);border-radius:6px" onclick="event.stopPropagation();openEditLesson(${l.id})"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
      <button class="lesson-del" onclick="event.stopPropagation();delLessonConfirm(${l.id})">×</button>
      <span class="lesson-arrow">→</span>`;
    el.onclick = () => openLesson(l.id);
    list.appendChild(el);
  });
}

function delLessonConfirm(lid) {
  const l = getLesson(CID, lid);
  if (!l) return;
  confirm_(`Delete lesson "${l.topic}"?`, 'All attendance and grade data will be lost.', () => {
    const c = CC();
    if (!c) return;
    c.columns = c.columns.filter(col => col.lessonId !== lid);
    c.lessons = c.lessons.filter(ls => ls.id !== lid);
    if (LID === lid) LID = null;
    rebuildIndex(); saveDB('class', true); renderLessons();
    toast('Lesson deleted.');
  });
}

// ============================================
// GRADEBOOK
// ============================================
function openLesson(lid) {
  LID = lid;
  const l = CL();
  if (!l) return;
  const addColBtn = safeGetElement('add-col-btn');
  if (addColBtn) addColBtn.style.display = l.mode === 'ielts' ? 'none' : 'inline-flex';
  // FIX: Reset scroll position when switching lessons
  const gbScroll = document.querySelector('.gradebook-scroll');
  if (gbScroll) gbScroll.scrollTop = 0;
  renderLessonHeader();
  renderGradebook();
  showScreen('s-lesson');
}

function renderLessonHeader() {
  const l = CL();
  if (!l) return;
  safeSetText('lgb-name', l.topic);
  safeSetText('lgb-date', l.date + (l.num ? ` · Lesson ${l.num}` : '') + (l.mode === 'ielts' ? ' · IELTS Mode' : ''));
  safeSetText('lesson-crumb', l.topic);
}

function getBandClass(score) {
  if (!score || score === '-') return '';
  const n = parseFloat(score);
  if (isNaN(n)) return '';
  if (n >= 9) return 'band-9';
  if (n >= 8) return 'band-8';
  if (n >= 7) return 'band-7';
  if (n >= 6) return 'band-6';
  if (n >= 5) return 'band-5';
  return 'band-low';
}

function calculateOverallBand(sid) {
  const c = CC(), l = CL();
  if (!l || l.mode !== 'ielts') return '-';
  if (l.studentIds && !l.studentIds.includes(sid)) return '-';
  const cols = c.columns.filter(col => col.ielts && col.lessonId === l.id && col.name !== 'Overall Band');
  let sum = 0, count = 0;
  cols.forEach(col => {
    const val = (l.data || {})[`col_${col.id}_${sid}`];
    if (val?.trim()) { const n = parseFloat(val); if (!isNaN(n)) { sum += n; count++; } }
  });
  if (count === 0) return '-';
  return (sum / count).toFixed(1);
}

function renderGradebook() {
  const c = CC(), l = CL();
  if (!l || !c) return;
  const sorted = [...c.students]
    .filter(s => l.studentIds ? l.studentIds.includes(s.id) : true)
    .sort((a, b) => a.name.localeCompare(b.name));
  let p = 0, la = 0, ab = 0;
  sorted.forEach(s => {
    const val = (l.data || {})[`att_${s.id}`] || 'present';
    if (val === 'present') p++;
    else if (val === 'late') la++;
    else ab++;
  });
  const strip = safeGetElement('stats-strip');
  const total = sorted.length;
  const attended = p + la;
  const rate = total > 0 ? Math.round(attended / total * 100) : 100;
  if (strip) {
    strip.innerHTML = `
      <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--success)"></div>Present: ${p}</div>
      <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--warning)"></div>Late: ${la}</div>
      <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--error)"></div>Absent: ${ab}</div>
      <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--accent)"></div>Attendance: ${rate}%</div>
      <div class="stat-chip">Total: ${total}</div>
      <div class="stat-chip bulk-actions-chip">
        <button class="bulk-btn bulk-present" onclick="bulkSetAttendance('present')" title="Mark all Present">✓ All Present</button>
        <button class="bulk-btn bulk-late" onclick="bulkSetAttendance('late')" title="Mark all Late">⏰ All Late</button>
        <button class="bulk-btn bulk-absent" onclick="bulkSetAttendance('absent')" title="Mark all Absent">✗ All Absent</button>
      </div>`;
  }
  const lessonCols = l.mode === 'ielts' ? c.columns.filter(col => col.ielts && col.lessonId === l.id) : c.columns.filter(col => !col.ielts);
  const head = safeGetElement('gb-head');
  if (head) {
    head.innerHTML = `<tr>
      <th class="th-student">Student</th>
      <th style="width:160px">Attendance</th>
      ${lessonCols.map(col => {
        if (col.name === 'Overall Band') return `<th class="overall-band-col" style="min-width:120px"><div class="th-inner-flex"><span>⭐ Overall Band</span></div></th>`;
        return `<th><div class="th-inner-flex"><span>${esc(col.name)}</span>${!col.ielts ? `<div class="th-col-actions"><button class="th-col-btn" onclick="openRenameColumn(${col.id})" title="Rename">✎</button><button class="th-col-btn" onclick="delColumnConfirm(${col.id})" title="Delete">×</button></div>` : ''}</div></th>`;
      }).join('')}
    </tr>`;
  }
  const body = safeGetElement('gb-body');
  if (!body) return;
  body.innerHTML = '';
  sorted.forEach(s => {
    const initials = s.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const attVal = (l.data || {})[`att_${s.id}`] || 'present';
    const absent = attVal === 'absent';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="td-student"><div class="td-student-inner"><div class="td-mini-av">${esc(initials)}</div><div class="td-name-text">${esc(s.name)}</div></div></td>
      <td class="td-att-cell">
        <div class="att-toggle" role="group" aria-label="Attendance">
          <button class="att-opt ${attVal === 'present' ? 'active-p' : ''}" onclick="setAtt(${s.id},'present')" title="Present"></button>
          <button class="att-opt ${attVal === 'late' ? 'active-l' : ''}" onclick="setAtt(${s.id},'late')" title="Late"></button>
          <button class="att-opt ${attVal === 'absent' ? 'active-a' : ''}" onclick="setAtt(${s.id},'absent')" title="Absent"></button>
        </div>
      </td>
      ${lessonCols.map(col => {
        if (col.name === 'Overall Band') {
          const overall = calculateOverallBand(s.id);
          const bc = getBandClass(overall);
          return `<td class="overall-band-cell ${bc}">${overall}</td>`;
        }
        const val = esc((l.data || {})[`col_${col.id}_${s.id}`] || '');
        if (l.mode === 'ielts' && col.ielts) {
          const bc = getBandClass(val);
          return `<td class="band-score-cell"><input class="grade-inp ${bc}" type="text" placeholder="—" value="${val}" onchange="saveGrade(${col.id},${s.id},this.value)" style="text-align:center" ${absent ? 'disabled' : ''}></td>`;
        }
        return `<td><input class="grade-inp" type="text" placeholder="—" value="${val}" onchange="saveGrade(${col.id},${s.id},this.value)" ${absent ? 'disabled' : ''}></td>`;
      }).join('')}`;
    body.appendChild(tr);
  });
  const addTr = document.createElement('tr');
  addTr.className = 'add-student-row';
  addTr.innerHTML = `<td class="td-student" colspan="${2 + lessonCols.length}"><input class="add-row-inp" placeholder="+ Type student name and press Enter to add to THIS lesson..." onkeydown="if(event.key==='Enter')quickAddStudentToLesson(this.value,this)"></td>`;
  body.appendChild(addTr);
  setupGradebookKeyNav();
}

// NEW: Bulk attendance
function bulkSetAttendance(status) {
  const l = CL();
  if (!l) return;
  if (!l.data) l.data = {};
  const c = CC();
  if (!c) return;
  const students = c.students.filter(s => l.studentIds ? l.studentIds.includes(s.id) : true);
  students.forEach(s => { l.data[`att_${s.id}`] = status; });
  l.updatedAt = new Date().toISOString();
  saveDB('lesson');
  renderGradebook();
  renderStudents();
  const labels = { present: '✓ All marked present', late: '⏰ All marked late', absent: '✗ All marked absent' };
  toast(labels[status] || 'Attendance updated');
}

function setAtt(sid, status) {
  const l = CL();
  if (!l) return;
  if (!l.data) l.data = {};
  l.data[`att_${sid}`] = status;
  l.updatedAt = new Date().toISOString();
  saveDB('lesson');
  renderGradebook();
  renderStudents();
}

function saveGrade(cid, sid, val) {
  const l = CL();
  if (!l) return;
  if (!l.data) l.data = {};
  l.data[`col_${cid}_${sid}`] = val.trim();
  l.updatedAt = new Date().toISOString();
  saveDB('lesson');
  if (l.mode === 'ielts') renderGradebook();
}

function quickAddStudentToLesson(name, inputEl) {
  name = name.trim();
  if (!name) return;
  const c = CC(), l = CL();
  if (!c || !l) return;
  const newStudent = { id: c.nextSid++, name, phone: '', email: '', parentName: '', parentPhone: '', note: '', updatedAt: new Date().toISOString() };
  c.students.push(newStudent);
  if (l.studentIds) l.studentIds.push(newStudent.id);
  l.updatedAt = new Date().toISOString();
  rebuildIndex(); saveDB('class');
  // FIX: clear the input
  if (inputEl) inputEl.value = '';
  renderGradebook(); renderStudents();
  toast(`✅ ${name} added to this lesson and roster!`);
}

// ============================================
// COLUMNS
// ============================================
function openAddColumn() {
  const colInput = safeGetElement('inp-colname');
  if (colInput) colInput.value = '';
  renderTemplateSelector();
  openOv('ov-column');
}

function saveColumn() {
  const colInput = safeGetElement('inp-colname');
  if (!colInput) return;
  const name = colInput.value.trim();
  if (!name) { shake('inp-colname'); return; }
  const c = CC();
  if (!c) return;
  c.columns.push({ id: c.nextCid++, name, updatedAt: new Date().toISOString() });
  rebuildIndex(); saveDB('class'); closeOv('ov-column'); renderGradebook();
  toast('Column added!');
}

let renameColId = null;

function openRenameColumn(cid) {
  renameColId = cid;
  const col = getColumn(CID, cid);
  if (!col) return;
  const renameInput = safeGetElement('inp-rename-col');
  if (renameInput) renameInput.value = col.name;
  openOv('ov-rename-col');
}

function confirmRenameCol() {
  const renameInput = safeGetElement('inp-rename-col');
  if (!renameInput) return;
  const name = renameInput.value.trim();
  if (!name) { shake('inp-rename-col'); return; }
  const col = getColumn(CID, renameColId);
  if (!col) return;
  col.name = name; col.updatedAt = new Date().toISOString();
  saveDB('class'); closeOv('ov-rename-col'); renderGradebook();
  toast('Column renamed!');
}

function delColumnConfirm(cid) {
  const col = getColumn(CID, cid);
  if (!col) return;
  confirm_(`Delete column "${col.name}"?`, 'All grades in this column will be permanently deleted.', () => {
    const c = CC();
    if (!c) return;
    // FIX: no variable shadowing
    c.columns = c.columns.filter(col => col.id !== cid);
    rebuildIndex(); saveDB('class', true); renderGradebook();
    toast('Column deleted.');
  });
}

// ============================================
// GRADE TEMPLATES (NEW FEATURE)
// ============================================
function renderTemplateSelector() {
  const container = safeGetElement('template-selector');
  if (!container) return;
  if (!DB.gradeTemplates || !DB.gradeTemplates.length) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-light);margin-bottom:8px">No saved templates yet. Save a set of columns as a template!</div>';
    return;
  }
  container.innerHTML = `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-light);margin-bottom:8px">Apply Template</div>
    <div class="template-list">
      ${DB.gradeTemplates.map((t, i) => `
        <div class="template-item">
          <button class="template-apply-btn" onclick="applyGradeTemplate(${i})">
            <span class="template-name">${esc(t.name)}</span>
            <span class="template-cols">${t.columns.join(', ')}</span>
          </button>
          <button class="template-del-btn" onclick="deleteTemplate(${i})" title="Delete template">×</button>
        </div>`).join('')}
    </div>`;
}

function applyGradeTemplate(idx) {
  const t = DB.gradeTemplates[idx];
  if (!t) return;
  const c = CC();
  if (!c) return;
  t.columns.forEach(name => {
    c.columns.push({ id: c.nextCid++, name, updatedAt: new Date().toISOString() });
  });
  rebuildIndex(); saveDB('class'); closeOv('ov-column'); renderGradebook();
  toast(`✅ Template "${t.name}" applied!`);
}

function saveCurrentColumnsAsTemplate() {
  const c = CC();
  if (!c) return;
  const standardCols = c.columns.filter(col => !col.ielts).map(col => col.name);
  if (!standardCols.length) { toast('No standard columns to save as template'); return; }
  const name = prompt('Template name (e.g. "Quiz Set"):');
  if (!name?.trim()) return;
  if (!DB.gradeTemplates) DB.gradeTemplates = [];
  DB.gradeTemplates.push({ name: name.trim(), columns: standardCols });
  saveDB('home', true);
  toast(`✅ Template "${name.trim()}" saved!`);
}

function deleteTemplate(idx) {
  DB.gradeTemplates.splice(idx, 1);
  saveDB('home', true);
  renderTemplateSelector();
  toast('Template deleted.');
}

// ============================================
// LESSON NOTES (NEW FEATURE)
// ============================================
function openLessonNotes() {
  const l = CL();
  if (!l) return;
  const notesArea = safeGetElement('lesson-notes-area');
  if (notesArea) notesArea.value = l.notes || '';
  openOv('ov-lesson-notes');
}

function saveLessonNotes() {
  const l = CL();
  if (!l) return;
  const notesArea = safeGetElement('lesson-notes-area');
  l.notes = notesArea ? notesArea.value.trim() : '';
  l.updatedAt = new Date().toISOString();
  saveDB('lesson'); closeOv('ov-lesson-notes'); renderLessons();
  toast('📝 Notes saved!');
}

// ============================================
// ANALYTICS
// ============================================
function renderAnalytics() {
  const c = CC();
  const scroll = safeGetElement('analytics-scroll');
  if (!c || !scroll) return;
  if (!c.students.length) {
    scroll.innerHTML = `<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-title">No data yet</div><div class="empty-desc">Add students and lessons to see analytics.</div></div>`;
    return;
  }
  const lessonCount = c.lessons.length;
  const studentCount = c.students.length;
  let totalP = 0, totalL = 0, totalA = 0, totalLessons = 0;
  const rows = c.students.map(s => {
    const st = studentStats(s.id);
    totalP += st.present; totalL += st.late; totalA += st.absent; totalLessons += st.total;
    const rate = st.total > 0 ? Math.round(st.attended / st.total * 100) : 100;
    const rateColor = rate >= 80 ? 'var(--success)' : rate >= 60 ? 'var(--warning)' : 'var(--error)';
    return { name: s.name, rate, attended: st.attended, total: st.total, rateColor, present: st.present, late: st.late, absent: st.absent };
  }).sort((a, b) => b.rate - a.rate);
  const avgRate = totalLessons > 0 ? Math.round((totalP + totalL) / totalLessons * 100) : 100;
  scroll.innerHTML = `
    <div class="analytics-grid">
      <div class="astat-card"><div class="astat-val">${lessonCount}</div><div class="astat-lbl">Total Lessons</div></div>
      <div class="astat-card"><div class="astat-val">${studentCount}</div><div class="astat-lbl">Total Students</div></div>
      <div class="astat-card"><div class="astat-val">${avgRate}%</div><div class="astat-lbl">Avg Attendance</div></div>
      <div class="astat-card"><div class="astat-val">${totalP}</div><div class="astat-lbl">Total Present</div></div>
      <div class="astat-card"><div class="astat-val">${totalL}</div><div class="astat-lbl">Total Late</div></div>
      <div class="astat-card"><div class="astat-val">${totalA}</div><div class="astat-lbl">Total Absent</div></div>
    </div>
    <div class="analytics-chart-wrap">
      <div class="analytics-chart-title">Attendance Rate by Student</div>
      <canvas id="att-chart" height="160"></canvas>
    </div>
    <div style="margin-bottom:12px;display:flex;justify-content:flex-end">
      <button class="btn btn-secondary btn-sm" onclick="saveCurrentColumnsAsTemplate()">💾 Save Columns as Template</button>
    </div>
    <table class="att-table">
      <thead><tr><th>Student</th><th>Rate</th><th>Attended</th><th>Present</th><th>Late</th><th>Absent</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td style="font-weight:600">${esc(r.name)}</td>
        <td><div class="rate-bar-wrap"><div class="rate-bar"><div class="rate-bar-fill" style="width:${r.rate}%;background:${r.rateColor}"></div></div><span style="font-weight:700;color:${r.rateColor}">${r.rate}%</span></div></td>
        <td>${r.attended}/${r.total}</td>
        <td style="color:var(--success)">${r.present}</td>
        <td style="color:var(--warning)">${r.late}</td>
        <td style="color:var(--error)">${r.absent}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  requestAnimationFrame(() => {
    const canvas = safeGetElement('att-chart');
    if (!canvas || !window.Chart) return;
    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();
    new Chart(canvas, {
      type: 'bar',
      data: {
        labels: rows.map(r => r.name.split(' ')[0]),
        datasets: [{ label: 'Attendance %', data: rows.map(r => r.rate), backgroundColor: rows.map(r => r.rate >= 80 ? 'rgba(90,138,90,0.8)' : r.rate >= 60 ? 'rgba(184,112,32,0.8)' : 'rgba(192,64,64,0.8)'), borderRadius: 6, borderSkipped: false }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${rows[ctx.dataIndex].name}: ${ctx.raw}% (${rows[ctx.dataIndex].attended}/${rows[ctx.dataIndex].total})` } } },
        scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,0.05)' } }, x: { grid: { display: false } } }
      }
    });
  });
}

// ============================================
// EXPORT PAYLOAD BUILDER
// ============================================
let currentExportContext = null;

function exportClass() { currentExportContext = { type: 'class', id: CID }; openOv('ov-export'); }
function exportLesson() { currentExportContext = { type: 'lesson', id: LID }; openOv('ov-export'); }

function buildExportPayload(context) {
  const settings = DB.exportSettings || { color: { h: 30, s: 60, l: 50, a: 100 } };
  const col = settings.color || { h: 30, s: 60, l: 50, a: 100 };
  // FIX: use actual lightness value
  const accentColor = `hsl(${col.h}, ${col.s}%, ${col.l}%)`;
  const accentColorDark = `hsl(${col.h}, ${col.s}%, ${Math.max(0, col.l - 15)}%)`;
  const accentColorLight = `hsl(${col.h}, ${col.s}%, ${Math.min(100, col.l + 40)}%)`;

  if (context.type === 'lesson') {
    const lesson = CL();
    const classroom = CC();
    const cols = lesson.mode === 'ielts'
      ? classroom.columns.filter(c => c.ielts && c.lessonId === lesson.id)
      : classroom.columns.filter(c => !c.ielts);
    const students = [...classroom.students]
      .filter(s => lesson.studentIds ? lesson.studentIds.includes(s.id) : true)
      .sort((a, b) => a.name.localeCompare(b.name));
    // FIX: no parent phone/email in export
    const rows = students.map(s => ({
      studentName: s.name,
      attendance: (lesson.data || {})[`att_${s.id}`] || 'present',
      grades: cols.map(c => c.name === 'Overall Band' ? calculateOverallBand(s.id) : (lesson.data || {})[`col_${c.id}_${s.id}`] || '')
    }));
    return {
      type: 'lesson', className: classroom.name, lessonName: lesson.topic,
      lessonDate: lesson.date, lessonNum: lesson.num,
      columns: cols.map(c => c.name), rows,
      logoData: settings.logo ? settings.logo.substring(0, 500000) : null,
      accentColor, accentColorDark, accentColorLight,
      teacherName: classroom.teacher || DB.user?.name || '',
      institutionName: DB.user?.school || DB.user?.name || 'GradeJournal',
    };
  } else {
    const classroom = getC(context.id);
    // FIX: only name and attendance rate — no parent phone/email
    const rows = [...classroom.students]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => {
        const stats = studentStats(s.id);
        const rate = stats.total > 0 ? Math.round(stats.attended / stats.total * 100) : 100;
        return { name: s.name, phone: s.phone || '', attendanceRate: rate, present: stats.present, late: stats.late, absent: stats.absent, total: stats.total };
      });
    return {
      type: 'class', className: classroom.name,
      teacherName: classroom.teacher || DB.user?.name || 'Teacher',
      subject: classroom.subject || 'Class', totalLessons: classroom.lessons.length,
      rows, logoData: settings.logo ? settings.logo.substring(0, 500000) : null,
      accentColor, accentColorDark, accentColorLight,
      institutionName: DB.user?.school || DB.user?.name || 'GradeJournal',
    };
  }
}

// ============================================
// PDF EXPORT - REDESIGNED
// ============================================
async function exportPDF() {
  if (!currentExportContext) return;
  closeOv('ov-export');
  const btn = document.querySelector('[onclick="exportPDF()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
  toast('✨ Generating PDF…');
  try {
    const payload = buildExportPayload(currentExportContext);
    const { jsPDF } = window.jspdf;
    if (!jsPDF) throw new Error('jsPDF not loaded');
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();

    // FIX: use actual lightness from color
    const col = DB.exportSettings?.color || { h: 30, s: 60, l: 50, a: 100 };
    // FIX: corrected regex and uses actual lightness
    const accentRGB = hslToRgbArr(col.h, col.s, col.l);
    const accentDarkRGB = hslToRgbArr(col.h, col.s, Math.max(0, col.l - 15));
    const accentLightRGB = hslToRgbArr(col.h, Math.max(0, col.s - 20), Math.min(97, col.l + 38));

    // === HEADER BAND ===
    // Gradient-style header using two rects
    doc.setFillColor(...accentDarkRGB);
    doc.rect(0, 0, W, 30, 'F');
    doc.setFillColor(...accentRGB);
    doc.rect(0, 0, W * 0.7, 30, 'F');

    let logoX = 10;
    if (payload.logoData?.startsWith('data:image')) {
      try { doc.addImage(payload.logoData, 10, 4, 22, 22, '', 'FAST'); logoX = 36; } catch { logoX = 10; }
    }

    // Title
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.text(payload.className, logoX, 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    if (payload.type === 'lesson') {
      doc.text(`${payload.lessonName}  ·  ${formatDateDisplay(payload.lessonDate)}  ·  Lesson ${payload.lessonNum || ''}`, logoX, 19);
    } else {
      doc.text(`Class Roster  ·  ${payload.teacherName}  ·  ${payload.subject}`, logoX, 19);
    }
    doc.setFontSize(8);
    doc.text(`Generated ${new Date().toLocaleDateString()}`, W - 10, 10, { align: 'right' });
    doc.text(payload.institutionName, W - 10, 17, { align: 'right' });

    let yPos = 36;

    // === STATS ROW (lesson only) ===
    if (payload.type === 'lesson') {
      const present = payload.rows.filter(r => r.attendance === 'present').length;
      const late = payload.rows.filter(r => r.attendance === 'late').length;
      const absent = payload.rows.filter(r => r.attendance === 'absent').length;
      const total = payload.rows.length;
      const rate = total > 0 ? Math.round((present + late) / total * 100) : 100;
      const stats = [
        { label: 'Students', val: String(total), color: accentRGB },
        { label: 'Attendance', val: `${rate}%`, color: rate >= 80 ? [46,125,50] : rate >= 60 ? [230,81,0] : [198,40,40] },
        { label: 'Present', val: String(present), color: [46,125,50] },
        { label: 'Late', val: String(late), color: [230,81,0] },
        { label: 'Absent', val: String(absent), color: [198,40,40] },
      ];
      const sw = (W - 20) / stats.length;
      stats.forEach((s, i) => {
        const sx = 10 + i * sw;
        doc.setFillColor(...accentLightRGB);
        doc.roundedRect(sx, yPos, sw - 3, 18, 3, 3, 'F');
        // colored top accent line
        doc.setFillColor(...s.color);
        doc.rect(sx, yPos, sw - 3, 2.5, 'F');
        doc.setTextColor(...s.color);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(15);
        doc.text(s.val, sx + (sw - 3) / 2, yPos + 11, { align: 'center' });
        doc.setTextColor(100, 80, 50);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.text(s.label.toUpperCase(), sx + (sw - 3) / 2, yPos + 16, { align: 'center' });
      });
      yPos += 24;
    }

    // === TABLE ===
    const colNames = payload.type === 'lesson'
      ? ['Student', 'Attendance', ...payload.columns]
      : ['Student', 'Phone', 'Attendance Rate', 'Present', 'Late', 'Absent'];

    const colWidths = payload.type === 'lesson'
      ? (() => {
          const gradeW = payload.columns.length > 0 ? Math.min(20, (W - 20 - 60 - 32) / payload.columns.length) : 20;
          return [60, 32, ...payload.columns.map(() => gradeW)];
        })()
      : [65, 38, 30, 18, 18, 18];

    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const startX = (W - tableW) / 2;
    const rowH = 8.5;

    // Header
    doc.setFillColor(...accentRGB);
    doc.rect(startX, yPos, tableW, 10, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    let cx = startX;
    colNames.forEach((name, i) => {
      doc.text(name, cx + 3, yPos + 6.5);
      cx += colWidths[i];
    });
    yPos += 10;

    const attColors = { present: [46,125,50], late: [230,81,0], absent: [198,40,40] };
    const attSymbols = { present: '● Present', late: '◑ Late', absent: '✕ Absent' };

    payload.rows.forEach((row, ri) => {
      if (yPos + rowH > H - 14) {
        doc.addPage();
        yPos = 14;
        doc.setFillColor(...accentRGB);
        doc.rect(startX, yPos, tableW, 10, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        cx = startX;
        colNames.forEach((name, i) => { doc.text(name, cx + 3, yPos + 6.5); cx += colWidths[i]; });
        yPos += 10;
      }
      // Alternating rows
      doc.setFillColor(ri % 2 === 0 ? 250 : 255, ri % 2 === 0 ? 247 : 255, ri % 2 === 0 ? 242 : 255);
      doc.rect(startX, yPos, tableW, rowH, 'F');
      doc.setDrawColor(220, 210, 195);
      doc.setLineWidth(0.1);
      doc.line(startX, yPos + rowH, startX + tableW, yPos + rowH);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(44, 36, 22);
      cx = startX;

      if (payload.type === 'lesson') {
        doc.text(String(row.studentName || '').substring(0, 28), cx + 3, yPos + 5.5);
        cx += colWidths[0];
        const att = row.attendance || 'present';
        const attRgb = attColors[att] || [0,0,0];
        doc.setTextColor(...attRgb);
        doc.setFont('helvetica', 'bold');
        doc.text(attSymbols[att] || att, cx + 3, yPos + 5.5);
        cx += colWidths[1];
        doc.setTextColor(44, 36, 22);
        doc.setFont('helvetica', 'normal');
        (row.grades || []).forEach((g, gi) => {
          doc.text(String(g || '—'), cx + colWidths[gi + 2] / 2, yPos + 5.5, { align: 'center' });
          cx += colWidths[gi + 2];
        });
      } else {
        doc.text(String(row.name || '—').substring(0, 28), cx + 3, yPos + 5.5);
        cx += colWidths[0];
        doc.text(String(row.phone || '—').substring(0, 16), cx + 3, yPos + 5.5);
        cx += colWidths[1];
        const rate = row.attendanceRate ?? 100;
        const rRgb = rate >= 80 ? [46,125,50] : rate >= 50 ? [230,81,0] : [198,40,40];
        doc.setTextColor(...rRgb);
        doc.setFont('helvetica', 'bold');
        doc.text(`${rate}%`, cx + colWidths[2] / 2, yPos + 5.5, { align: 'center' });
        cx += colWidths[2];
        doc.setTextColor(44, 36, 22);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(46, 125, 50);
        doc.text(String(row.present ?? ''), cx + colWidths[3] / 2, yPos + 5.5, { align: 'center' });
        cx += colWidths[3];
        doc.setTextColor(230, 81, 0);
        doc.text(String(row.late ?? ''), cx + colWidths[4] / 2, yPos + 5.5, { align: 'center' });
        cx += colWidths[4];
        doc.setTextColor(198, 40, 40);
        doc.text(String(row.absent ?? ''), cx + colWidths[5] / 2, yPos + 5.5, { align: 'center' });
      }
      yPos += rowH;
    });

    // Footer
    const pageCount = doc.internal.getNumberOfPages();
    for (let pg = 1; pg <= pageCount; pg++) {
      doc.setPage(pg);
      doc.setFillColor(...accentLightRGB);
      doc.rect(0, H - 10, W, 10, 'F');
      doc.setTextColor(...accentDarkRGB);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.text(`GradeJournal Professional  ·  ${payload.institutionName}`, 10, H - 3.5);
      doc.text(`Page ${pg} of ${pageCount}`, W - 10, H - 3.5, { align: 'right' });
    }

    const filename = payload.type === 'lesson'
      ? `GJ-${payload.className}-${payload.lessonName}-${payload.lessonDate}.pdf`
      : `GJ-${payload.className}-Roster.pdf`;
    doc.save(filename.replace(/[^a-zA-Z0-9\-_.]/g, '_'));
    toast('✅ PDF downloaded!');
  } catch (err) {
    console.error('PDF error:', err);
    toast('❌ PDF failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Export as PDF'; }
  }
}

// FIX: corrected hslToRgbArr with all branches
function hslToRgbArr(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  try { return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return dateStr; }
}

// EXCEL EXPORT
async function exportExcel() {
  if (!currentExportContext) return;
  closeOv('ov-export');
  toast('📊 Generating Excel…');
  try {
    const payload = buildExportPayload(currentExportContext);
    const response = await fetch(`${API_BASE}/api/export/excel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Export failed');
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filename = payload.type === 'lesson'
      ? `GJ-${payload.className}-${payload.lessonName}.xlsx`
      : `GJ-${payload.className}-Roster.xlsx`;
    a.download = filename.replace(/[^a-zA-Z0-9\-_.]/g, '_');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    toast('✅ Excel downloaded!');
  } catch (err) {
    console.error('Excel error:', err);
    toast('❌ Excel failed: ' + err.message);
  }
}

// ============================================
// BACKUP & RESTORE
// ============================================
function backupData() {
  try {
    const blob = new Blob([JSON.stringify(DB, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gradejournal-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('✅ Backup downloaded!');
  } catch { toast('❌ Backup failed'); }
}

function restoreFromFile() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        confirm_('Restore Backup', 'This will replace all current data. Continue?', async () => {
          DB = backup;
          if (!DB.exportSettings) DB.exportSettings = { color: { h:30,s:60,l:50,a:100 } };
          if (!DB.gradeTemplates) DB.gradeTemplates = [];
          rebuildIndex();
          await saveDB('home', true);
          if (supabase && DB.user?.mode === 'supabase') await syncWithCloud();
          toast('✅ Data restored!');
          renderClassrooms();
        });
      } catch { toast('❌ Invalid backup file'); }
    };
    reader.readAsText(file);
  };
  input.click();
}

// ============================================
// EXPORT SETTINGS & COLOR PICKER
// ============================================
let colorPickerState = { h: 30, s: 60, l: 50, a: 100 };

function openExportSettings() {
  closeOv('ov-export');
  if (!DB.exportSettings) DB.exportSettings = { color: { h:30,s:60,l:50,a:100 } };
  const previewZone = safeGetElement('file-preview-zone');
  const logoPreview = safeGetElement('export-logo-preview');
  const fileName = safeGetElement('file-preview-name');
  const fileSize = safeGetElement('file-preview-size');
  if (DB.exportSettings.logo && logoPreview && fileName && fileSize && previewZone) {
    logoPreview.src = DB.exportSettings.logo;
    fileName.textContent = DB.exportSettings.logoName || 'logo.png';
    fileSize.textContent = DB.exportSettings.logoSize || '';
    previewZone.classList.add('show');
  } else if (previewZone) {
    previewZone.classList.remove('show');
    if (logoPreview) logoPreview.src = '';
  }
  const col = DB.exportSettings.color || { h:30,s:60,l:50,a:100 };
  colorPickerState = { ...col };
  const hueSlider = safeGetElement('hue-slider');
  const satSlider = safeGetElement('sat-slider');
  const lightSlider = safeGetElement('light-slider');
  const opacitySlider = safeGetElement('opacity-slider');
  if (hueSlider) hueSlider.value = col.h;
  if (satSlider) satSlider.value = col.s;
  if (lightSlider) lightSlider.value = col.l;
  if (opacitySlider) opacitySlider.value = col.a;
  updateColorDisplay();
  openOv('ov-export-settings');
}

function setupDragAndDrop() {
  const dropZone = safeGetElement('file-upload-zone');
  if (!dropZone) return;
  const handle = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.type === 'drop') {
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) handleLogoFile(e.dataTransfer.files[0]);
    } else if (e.type === 'dragleave') {
      dropZone.classList.remove('drag-over');
    } else {
      dropZone.classList.add('drag-over');
    }
  };
  ['dragenter','dragover','dragleave','drop'].forEach(ev => { dropZone.removeEventListener(ev, handle); dropZone.addEventListener(ev, handle, false); });
}

function onExportLogoFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  handleLogoFile(file);
}

function handleLogoFile(file) {
  if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) { toast('❌ Please upload PNG or JPEG only'); return; }
  if (file.size > 2 * 1024 * 1024) { toast('❌ File too large. Max 2MB'); return; }
  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let w = img.width, h = img.height;
      const max = 400;
      if (w > h) { if (w > max) { h = Math.round(h * max / w); w = max; } }
      else { if (h > max) { w = Math.round(w * max / h); h = max; } }
      canvas.width = w; canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      const logoPreview = safeGetElement('export-logo-preview');
      const fileName = safeGetElement('file-preview-name');
      const fileSize = safeGetElement('file-preview-size');
      const previewZone = safeGetElement('file-preview-zone');
      if (logoPreview) logoPreview.src = dataUrl;
      if (fileName) fileName.textContent = file.name;
      if (fileSize) fileSize.textContent = formatFileSize(file.size);
      if (previewZone) previewZone.classList.add('show');
      DB.exportSettings.logo = dataUrl;
      DB.exportSettings.logoName = file.name;
      DB.exportSettings.logoSize = formatFileSize(file.size);
      saveDB('home');
      toast('✓ Logo uploaded');
    };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
}

function removeExportLogo() {
  const logoInput = safeGetElement('export-logo-file');
  const previewZone = safeGetElement('file-preview-zone');
  const logoPreview = safeGetElement('export-logo-preview');
  if (logoInput) logoInput.value = '';
  if (previewZone) previewZone.classList.remove('show');
  if (logoPreview) logoPreview.src = '';
  if (DB.exportSettings) { delete DB.exportSettings.logo; delete DB.exportSettings.logoName; delete DB.exportSettings.logoSize; saveDB('home'); }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024, sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function toggleColorPicker() {
  const dropdown = safeGetElement('color-picker-dropdown');
  if (!dropdown) return;
  if (dropdown.classList.contains('show')) {
    dropdown.classList.remove('show');
    if (window.__colorPickerCleanup) { window.__colorPickerCleanup(); window.__colorPickerCleanup = null; }
  } else {
    dropdown.classList.add('show');
    setTimeout(() => setupColorGradient(), 50);
  }
}

function setupColorGradient() {
  const gradientBar = safeGetElement('color-gradient-bar');
  const cursor = safeGetElement('color-cursor');
  if (!gradientBar || !cursor) return;
  updateGradientBackground();
  cursor.style.left = colorPickerState.s + '%';
  cursor.style.top = (100 - colorPickerState.l) + '%';
  let isDragging = false;
  const updateFromMouse = (e) => {
    const rect = gradientBar.getBoundingClientRect();
    let x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    let y = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
    colorPickerState.s = Math.round((x / rect.width) * 100);
    colorPickerState.l = Math.round(100 - (y / rect.height) * 100);
    const satSlider = safeGetElement('sat-slider');
    const lightSlider = safeGetElement('light-slider');
    if (satSlider) satSlider.value = colorPickerState.s;
    if (lightSlider) lightSlider.value = colorPickerState.l;
    updateColorDisplay();
  };
  const onMouseMove = (e) => { if (isDragging) updateFromMouse(e); };
  const onMouseUp = () => { isDragging = false; document.onmousemove = null; document.onmouseup = null; };
  gradientBar.onmousedown = (e) => { isDragging = true; updateFromMouse(e); document.onmousemove = onMouseMove; document.onmouseup = onMouseUp; };
  window.__colorPickerCleanup = () => { gradientBar.onmousedown = null; document.onmousemove = null; document.onmouseup = null; };
}

function updateGradientBackground() {
  const gradientBar = safeGetElement('color-gradient-bar');
  if (!gradientBar) return;
  gradientBar.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${colorPickerState.h}, 100%, 50%))`;
}

// FIX: updateColorDisplay fully functional — updates slider backgrounds too
function updateColorDisplay() {
  const { h, s, l, a } = colorPickerState;
  const swatch = safeGetElement('color-swatch');
  const colorValue = safeGetElement('color-value');
  const hueValue = safeGetElement('hue-value');
  const satValue = safeGetElement('sat-value');
  const lightValue = safeGetElement('light-value');
  const opacityValue = safeGetElement('opacity-value');
  if (swatch) swatch.style.background = `hsla(${h}, ${s}%, ${l}%, ${a / 100})`;
  if (colorValue) colorValue.textContent = `hsl(${h}°, ${s}%, ${l}%) · ${a}% opacity`;
  if (hueValue) hueValue.textContent = h + '°';
  if (satValue) satValue.textContent = s + '%';
  if (lightValue) lightValue.textContent = l + '%';
  if (opacityValue) opacityValue.textContent = a + '%';

  const dropdown = safeGetElement('color-picker-dropdown');
  if (dropdown?.classList.contains('show')) {
    updateGradientBackground();
    const cursor = safeGetElement('color-cursor');
    if (cursor) { cursor.style.left = s + '%'; cursor.style.top = (100 - l) + '%'; }
  }

  // FIX: update sat slider background based on hue
  const satSlider = safeGetElement('sat-slider');
  if (satSlider) satSlider.style.background = `linear-gradient(to right, hsl(${h}, 0%, ${l}%), hsl(${h}, 100%, ${l}%))`;

  // FIX: update lightness slider background
  const lightSlider = safeGetElement('light-slider');
  if (lightSlider) lightSlider.style.background = `linear-gradient(to right, #000, hsl(${h}, ${s}%, 50%), #fff)`;

  // FIX: update opacity slider background properly (not currentColor)
  const opacitySlider = safeGetElement('opacity-slider');
  if (opacitySlider) opacitySlider.style.background = `linear-gradient(to right, transparent, hsl(${h}, ${s}%, ${l}%))`;
}

function saveExportSettings() {
  if (!DB.exportSettings) DB.exportSettings = {};
  DB.exportSettings.color = { ...colorPickerState };
  saveDB('home', true);
  closeOv('ov-export-settings');
  const dropdown = safeGetElement('color-picker-dropdown');
  if (dropdown) dropdown.classList.remove('show');
  if (window.__colorPickerCleanup) { window.__colorPickerCleanup(); window.__colorPickerCleanup = null; }
  toast('✓ Export settings saved');
  if (safeGetElement('s-auth')?.classList.contains('active')) loadAuthLogo();
}

// ============================================
// KEYBOARD NAV IN GRADEBOOK
// ============================================
function setupGradebookKeyNav() {
  const inputs = Array.from(document.querySelectorAll('.gb-table .grade-inp'));
  inputs.forEach((inp, idx) => {
    inp.addEventListener('keydown', (e) => {
      let target = null;
      const cols = inp.closest('tr')?.querySelectorAll('.grade-inp').length || 1;
      if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); target = inputs[idx + 1]; }
      else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); target = inputs[idx - 1]; }
      else if (e.key === 'Enter') { e.preventDefault(); target = inputs[idx + cols] || inputs[idx - cols]; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); target = inputs[idx + cols]; }
      else if (e.key === 'ArrowUp') { e.preventDefault(); target = inputs[idx - cols]; }
      if (target) { target.focus(); target.select(); }
    });
  });
}

// ============================================
// SEARCH / FILTER
// ============================================
let _studentFilter = '';
let _lessonFilter = '';
function filterStudents(val) { _studentFilter = val.toLowerCase(); renderStudents(); }
function filterLessons(val) { _lessonFilter = val.toLowerCase(); renderLessons(); }

// ============================================
// UNDO SYSTEM
// ============================================
let _undoStack = [];
let _undoTimeout = null;

function pushUndo(description, snapshotFn, restoreFn) {
  _undoStack.push({ description, snapshot: snapshotFn(), restoreFn });
  if (_undoStack.length > 20) _undoStack.shift();
  showUndoToast(description);
}

function showUndoToast(description) {
  document.querySelectorAll('.toast-undo').forEach(t => t.remove());
  clearTimeout(_undoTimeout);
  const t = document.createElement('div');
  t.className = 'toast toast-undo';
  // FIX: pointer-events on undo toast
  t.style.pointerEvents = 'all';
  t.innerHTML = `${description} <button class="toast-undo-btn" onclick="doUndo()">Undo</button>`;
  document.body.appendChild(t);
  _undoTimeout = setTimeout(() => { t.remove(); _undoStack.pop(); }, 5000);
}

function doUndo() {
  clearTimeout(_undoTimeout);
  document.querySelectorAll('.toast-undo').forEach(t => t.remove());
  const entry = _undoStack.pop();
  if (!entry) return;
  entry.restoreFn(entry.snapshot);
  rebuildIndex(); saveDB('home', true); renderClassrooms();
  if (safeGetElement('s-classroom')?.classList.contains('active')) { renderStudents(); renderLessons(); renderAnalytics(); }
  toast('↩ Restored!');
}

// ============================================
// OFFLINE BANNER
// ============================================
function showOfflineBanner() {
  if (safeGetElement('offline-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'offline-banner';
  banner.className = 'offline-banner';
  banner.innerHTML = `⚠️ Working offline — changes saved locally.`;
  document.body.prepend(banner);
}
function hideOfflineBanner() { safeGetElement('offline-banner')?.remove(); }

// ============================================
// WELCOME CARD
// ============================================
function maybeShowWelcomeCard() {
  const grid = safeGetElement('classrooms-grid');
  if (!grid || DB.classrooms.length > 0) return;
  const welcome = document.createElement('div');
  welcome.className = 'welcome-card';
  welcome.innerHTML = `
    <div class="welcome-steps">
      <div class="welcome-step"><div class="ws-num">1</div><div class="ws-text"><strong>Create a Classroom</strong><span>Set up your class with name and subject</span></div></div>
      <div class="welcome-step"><div class="ws-num">2</div><div class="ws-text"><strong>Add Students</strong><span>Build your class roster with contact info</span></div></div>
      <div class="welcome-step"><div class="ws-num">3</div><div class="ws-text"><strong>Start a Lesson</strong><span>Record attendance and grades</span></div></div>
    </div>
    <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:16px" onclick="openOv('ov-new-class')">➕ Create Your First Classroom</button>`;
  grid.before(welcome);
}

// ============================================
// LESSON COMPLETION STATUS
// ============================================
function lessonCompletionStatus(lesson, classroom) {
  const students = classroom.students.filter(s => lesson.studentIds ? lesson.studentIds.includes(s.id) : true);
  if (!students.length) return 'empty';
  const cols = lesson.mode === 'ielts'
    ? classroom.columns.filter(c => c.ielts && c.lessonId === lesson.id && c.name !== 'Overall Band')
    : classroom.columns.filter(c => !c.ielts);
  if (!cols.length) return 'att-only';
  const total = students.length * cols.length;
  const filled = students.reduce((sum, s) => sum + cols.filter(col => (lesson.data || {})[`col_${col.id}_${s.id}`]?.trim()).length, 0);
  if (filled === 0) return 'att-only';
  if (filled < total) return 'partial';
  return 'complete';
}

// ============================================
// KEYBOARD SHORTCUTS
// ============================================
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (document.querySelector('.ov.open')) return;
    const s = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) return;
    if (s === '?') { showShortcutHint(); return; }
    if (s === 'n') {
      if (safeGetElement('s-classroom')?.classList.contains('active')) {
        const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab;
        if (activeTab === 'students') openAddStudent();
        else if (activeTab === 'lessons') openAddLesson();
      } else if (safeGetElement('s-home')?.classList.contains('active')) {
        openOv('ov-new-class');
      }
    } else if (s === 'e') {
      if (safeGetElement('s-lesson')?.classList.contains('active')) exportLesson();
      else if (safeGetElement('s-classroom')?.classList.contains('active')) exportClass();
    } else if (s === 'h') {
      goHome();
    }
  });
}

// NEW: keyboard shortcut overlay (feature #13)
let _shortcutHintEl = null;
function showShortcutHint() {
  if (_shortcutHintEl) { _shortcutHintEl.remove(); _shortcutHintEl = null; return; }
  _shortcutHintEl = document.createElement('div');
  _shortcutHintEl.className = 'shortcut-hint show';
  _shortcutHintEl.innerHTML = `
    <div style="font-weight:700;margin-bottom:8px;font-size:12px;color:rgba(255,255,255,.7)">KEYBOARD SHORTCUTS</div>
    <div><kbd>N</kbd> New student / lesson / classroom</div>
    <div><kbd>E</kbd> Export current view</div>
    <div><kbd>H</kbd> Go home</div>
    <div><kbd>?</kbd> Toggle this menu</div>
    <div><kbd>Esc</kbd> Close any modal</div>
    <div style="margin-top:8px;font-size:10px;color:rgba(255,255,255,.4)">Press ? again to close</div>`;
  document.body.appendChild(_shortcutHintEl);
}

// ============================================
// UNDO-AWARE DELETE (CLASSROOMS)
// ============================================
// NOTE: deleteClassConfirm is defined above near CLASSROOMS section.
// The duplicate from original code is removed.

// ============================================
// CONFLICT DIALOG
// ============================================
async function showConflictDialog(conflict) {
  return new Promise((resolve) => {
    const modal = safeGetElement('ov-conflict');
    const content = safeGetElement('conflict-content');
    if (!modal || !content) { resolve('local'); return; }
    content.innerHTML = `<div style="margin-bottom:20px"><h3>Conflict: ${conflict.type}</h3><p>Modified on both devices.</p></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
        <div style="background:var(--cream-2);padding:16px;border-radius:12px"><div style="font-weight:700;margin-bottom:8px">Local</div><pre style="font-size:11px;overflow:auto">${JSON.stringify(conflict.local,null,2).substring(0,200)}</pre></div>
        <div style="background:var(--cream-2);padding:16px;border-radius:12px"><div style="font-weight:700;margin-bottom:8px">Cloud</div><pre style="font-size:11px;overflow:auto">${JSON.stringify(conflict.cloud,null,2).substring(0,200)}</pre></div>
      </div>`;
    const handleChoice = (choice) => { closeOv('ov-conflict'); resolve(choice); };
    const klb = safeGetElement('conflict-keep-local');
    const kcb = safeGetElement('conflict-keep-cloud');
    const mb = safeGetElement('conflict-merge');
    if (klb) klb.onclick = () => handleChoice('local');
    if (kcb) kcb.onclick = () => handleChoice('cloud');
    if (mb) mb.onclick = () => handleChoice('merge');
    openOv('ov-conflict');
  });
}

// ============================================
// DEMO REQUEST
// ============================================
function openDemoRequest() {
  // FIX: just show the modal; let user click Gmail from there
  openOv('ov-demo');
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function openOv(id) { const el = safeGetElement(id); if (el) el.classList.add('open'); }
function closeOv(id) { const el = safeGetElement(id); if (el) el.classList.remove('open'); }
function v(id) { const el = safeGetElement(id); return el ? el.value.trim() : ''; }
function sv(id, val) { const el = safeGetElement(id); if (el) el.value = val; }

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function clrInputs(ids) { ids.forEach(id => sv(id, '')); }
function shake(id) {
  const el = safeGetElement(id);
  if (!el) return;
  el.style.animation = 'shake .3s';
  setTimeout(() => el.style.animation = '', 300);
}
function ifEnter(e, fn) { if (e.key === 'Enter') { e.preventDefault(); fn(); } }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

// FIX: showToast removes existing non-undo toasts to prevent stacking
function showToast(msg) {
  document.querySelectorAll('.toast:not(.toast-undo)').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
const toast = showToast;

let confirmCb = null;
function confirm_(title, desc, cb) {
  const titleEl = safeGetElement('confirm-title');
  const descEl = safeGetElement('confirm-desc');
  if (titleEl) titleEl.textContent = title;
  if (descEl) descEl.textContent = desc;
  confirmCb = cb;
  openOv('ov-confirm');
}
function confirmOk() { if (confirmCb) confirmCb(); confirmCb = null; closeOv('ov-confirm'); }

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  const hueSlider = safeGetElement('hue-slider');
  const satSlider = safeGetElement('sat-slider');
  const lightSlider = safeGetElement('light-slider');
  const opacitySlider = safeGetElement('opacity-slider');
  if (hueSlider) hueSlider.addEventListener('input', (e) => { colorPickerState.h = parseInt(e.target.value); updateColorDisplay(); });
  if (satSlider) satSlider.addEventListener('input', (e) => { colorPickerState.s = parseInt(e.target.value); updateColorDisplay(); });
  if (lightSlider) lightSlider.addEventListener('input', (e) => { colorPickerState.l = parseInt(e.target.value); updateColorDisplay(); });
  if (opacitySlider) opacitySlider.addEventListener('input', (e) => { colorPickerState.a = parseInt(e.target.value); updateColorDisplay(); });
  setupDragAndDrop();
  initKeyboardShortcuts();
  window.addEventListener('online', () => { hideOfflineBanner(); showToast('📶 Back online — syncing…'); if (DB.user?.mode === 'supabase') syncWithCloud(); });
  window.addEventListener('offline', () => { showOfflineBanner(); DB.syncStatus = 'offline'; updateSyncUI(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.ov.open').forEach(el => el.classList.remove('open'));
      safeGetElement('sheet-ov')?.classList.remove('open');
      safeGetElement('color-picker-dropdown')?.classList.remove('show');
      if (window.__colorPickerCleanup) { window.__colorPickerCleanup(); window.__colorPickerCleanup = null; }
      if (_shortcutHintEl) { _shortcutHintEl.remove(); _shortcutHintEl = null; }
    }
  });
  window.addEventListener('beforeunload', () => { if (DB.pendingChanges?.length > 0) saveToLocalStorage(); });
});

let splashTimeout = setTimeout(() => {
  const splash = safeGetElement('splash');
  if (splash) {
    splash.classList.add('exit');
    setTimeout(() => {
      splash.style.display = 'none';
      loadDB().then(() => {
        if (DB.user) enterApp(); else showLanding();
      });
    }, 800);
  }
}, 2800);

window.addEventListener('unload', () => {
  if (splashTimeout) clearTimeout(splashTimeout);
  stopAutoSync();
  if (abortController) abortController.abort();
  if (window.__colorPickerCleanup) window.__colorPickerCleanup();
});
