'use strict';

// ============================================
// CONFIGURATION
// ============================================
const APP_VERSION = '6.0.0';
const SYNC_INTERVAL = 30000; // 30 seconds
const MAX_RETRY_ATTEMPTS = 3;
const BATCH_SIZE = 25;

// ============================================
// DOM SAFETY CHECKS - NEW SECTION
// ============================================
function safeGetElement(id) {
  const el = document.getElementById(id);
  if (!el) console.warn(`Element with id "${id}" not found`);
  return el;
}

function safeAddClass(id, className) {
  const el = safeGetElement(id);
  if (el) el.classList.add(className);
}

function safeRemoveClass(id, className) {
  const el = safeGetElement(id);
  if (el) el.classList.remove(className);
}

function safeToggleClass(id, className, condition) {
  const el = safeGetElement(id);
  if (el) {
    if (condition) el.classList.add(className);
    else el.classList.remove(className);
  }
}

function safeSetText(id, text) {
  const el = safeGetElement(id);
  if (el) el.textContent = text;
}

// ============================================
// SUPABASE CLIENT
// ============================================
let supabase = null;
let currentUser = null;
let syncTimer = null;
let abortController = null;

function connectSupabaseClient() {
  if (window.supabaseClient?.supabase) {
    supabase = window.supabaseClient.supabase;
    return true;
  }
  return false;
}

connectSupabaseClient();
window.addEventListener('supabase:ready', connectSupabaseClient);

// ============================================
// DATABASE & STATE MANAGEMENT
// ============================================
let DB = { 
  classrooms: [], 
  nextId: 1, 
  user: null,
  lastSync: null,
  syncStatus: 'idle', // 'idle', 'syncing', 'error', 'offline'
  pendingChanges: [],
  exportSettings: {
    color: { h: 30, s: 60, l: 50, a: 100 },
    logo: null,
    logoName: null,
    logoSize: null
  }
};

// Index for fast lookups
let DB_INDEX = {
  classroomsById: new Map(),
  studentsByClassroom: new Map(),
  lessonsByClassroom: new Map(),
  columnsByClassroom: new Map()
};

// API base
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
function getStudent(classId, studentId) { 
  return DB_INDEX.studentsByClassroom.get(classId)?.get(studentId);
}
function getLesson(classId, lessonId) {
  return DB_INDEX.lessonsByClassroom.get(classId)?.get(lessonId);
}
function getColumn(classId, columnId) {
  return DB_INDEX.columnsByClassroom.get(classId)?.get(columnId);
}

let CID = null, LID = null;
function CC() { return getC(CID); }
function CL() { return CID && LID ? getLesson(CID, LID) : null; }

// ============================================
// DATA MERGING & SYNC
// ============================================
function mergeData(local, remote, strategy = 'timestamp') {
  if (!remote) return local;
  
  const merged = {
    ...local,
    classrooms: [],
    nextId: Math.max(local.nextId || 1, remote.nextId || 1),
    lastSync: new Date().toISOString()
  };
  
  // Create maps for efficient merging
  const localClassrooms = new Map(local.classrooms?.map(c => [c.id, c]) || []);
  const remoteClassrooms = new Map(remote.classrooms?.map(c => [c.id, c]) || []);
  
  // Merge all classroom IDs
  const allIds = new Set([...localClassrooms.keys(), ...remoteClassrooms.keys()]);
  
  for (const id of allIds) {
    const localC = localClassrooms.get(id);
    const remoteC = remoteClassrooms.get(id);
    
    if (localC && !remoteC) {
      // Only in local - keep it
      merged.classrooms.push(localC);
    } else if (!localC && remoteC) {
      // Only in remote - add it
      merged.classrooms.push(remoteC);
    } else if (localC && remoteC) {
      // In both - merge based on timestamp
      const localTime = new Date(localC.updatedAt || 0).getTime();
      const remoteTime = new Date(remoteC.updatedAt || 0).getTime();
      
      if (remoteTime > localTime) {
        // Remote is newer - use it but preserve local changes if any
        merged.classrooms.push({
          ...remoteC,
          students: mergeStudents(localC.students || [], remoteC.students || []),
          lessons: mergeLessons(localC.lessons || [], remoteC.lessons || [])
        });
      } else {
        // Local is newer or equal - keep it
        merged.classrooms.push(localC);
      }
    }
  }
  
  return merged;
}

// Generic merge helper used for both students and lessons
function mergeArrayById(local, remote) {
  const localMap = new Map(local.map(item => [item.id, item]));
  const remoteMap = new Map(remote.map(item => [item.id, item]));
  const merged = [];

  for (const [id, localItem] of localMap) {
    const remoteItem = remoteMap.get(id);
    if (remoteItem) {
      const localTime = new Date(localItem.updatedAt || 0).getTime();
      const remoteTime = new Date(remoteItem.updatedAt || 0).getTime();
      merged.push(remoteTime > localTime ? remoteItem : localItem);
    } else {
      merged.push(localItem);
    }
  }
  for (const [id, remoteItem] of remoteMap) {
    if (!localMap.has(id)) merged.push(remoteItem);
  }
  return merged;
}

function mergeStudents(local, remote) { return mergeArrayById(local, remote); }
function mergeLessons(local, remote)  { return mergeArrayById(local, remote); }

// ============================================
// LOAD/SAVE FUNCTIONS
// ============================================
async function loadDB() {
  try {
    abortController = new AbortController();
    
    // Load from localStorage with backup
    const localData = loadFromLocalStorage();
    if (localData) {
      DB = localData;
    }
    
    // Ensure exportSettings exists
    if (!DB.exportSettings) {
      DB.exportSettings = { color: { h: 30, s: 60, l: 50, a: 100 } };
    }
    
    // Add timestamps for merge
    DB.classrooms.forEach(c => {
      if (!c.updatedAt) c.updatedAt = new Date().toISOString();
      c.students?.forEach(s => { if (!s.updatedAt) s.updatedAt = c.updatedAt; });
      c.lessons?.forEach(l => { if (!l.updatedAt) l.updatedAt = c.updatedAt; });
    });
    
    // Rebuild index
    rebuildIndex();
    
    // If user is logged in with Supabase, sync with cloud
    if (supabase && DB.user?.mode === 'supabase' && DB.user?.id) {
      await syncWithCloud();
    }
    
    // Start auto-sync if logged in
    if (DB.user?.mode === 'supabase') {
      startAutoSync();
    }
    
    // Add studentIds to old lessons
    migrateLegacyData();
    
  } catch (e) {
    console.error('Failed to load DB', e);
    showToast('⚠️ Failed to load data. Using backup if available.');
    await loadFromBackup();
  }
}

function loadFromLocalStorage() {
  try {
    const main = localStorage.getItem('gj_v6_pro');
    const backup = localStorage.getItem('gj_v6_pro_backup');
    
    if (main) {
      return JSON.parse(main);
    } else if (backup) {
      return JSON.parse(backup);
    }
  } catch (e) {
    console.error('Error loading from localStorage:', e);
  }
  return null;
}

async function loadFromBackup() {
  try {
    const backup = localStorage.getItem('gj_v6_pro_backup');
    if (backup) {
      DB = JSON.parse(backup);
      rebuildIndex();
      showToast('✅ Restored from backup');
    }
  } catch (e) {
    console.error('Failed to load backup:', e);
  }
}

function migrateLegacyData() {
  DB.classrooms.forEach(classroom => {
    classroom.lessons.forEach(lesson => {
      if (!lesson.studentIds) {
        lesson.studentIds = classroom.students.map(s => s.id);
      }
      if (!lesson.updatedAt) {
        lesson.updatedAt = new Date().toISOString();
      }
    });
    classroom.students.forEach(s => {
      if (!s.updatedAt) s.updatedAt = new Date().toISOString();
    });
  });
}

// ============================================
// CLOUD SYNC
// ============================================
async function syncWithCloud() {
  if (!supabase || !DB.user?.id || DB.user?.mode !== 'supabase') {
    return;
  }
  
  if (DB.syncStatus === 'syncing') {
    console.log('Sync already in progress');
    return;
  }
  
  DB.syncStatus = 'syncing';
  updateSyncUI();
  
  try {
    // Load cloud data
    const cloudData = await loadUserDataFromSupabase(DB.user.id);
    
    // Merge with local data
    const merged = mergeData(DB, cloudData, 'timestamp');
    
    // Check for conflicts
    const conflicts = detectConflicts(DB, cloudData);
    if (conflicts.length > 0) {
      await resolveConflicts(conflicts);
    }
    
    // Apply merged data
    DB = merged;
    rebuildIndex();
    
    // Save to cloud
    await saveUserDataToSupabase(DB.user.id);
    
    // Save to local
    saveToLocalStorage();
    
    DB.lastSync = new Date().toISOString();
    DB.syncStatus = 'idle';
    DB.pendingChanges = [];
    
    updateSyncUI();
    showToast('✅ Synced with cloud');
    
  } catch (error) {
    console.error('Sync failed:', error);
    DB.syncStatus = 'error';
    updateSyncUI();
    showToast('❌ Sync failed. Changes saved locally.');
    
    // Queue changes for later sync
    queuePendingChanges();
  }
}

function detectConflicts(local, cloud) {
  const conflicts = [];
  if (!cloud?.classrooms) return conflicts;
  // Use Map for O(n) instead of O(n²)
  const cloudMap = new Map((cloud.classrooms || []).map(c => [c.id, c]));
  (local.classrooms || []).forEach(localC => {
    const cloudC = cloudMap.get(localC.id);
    if (cloudC && localC.updatedAt !== cloudC.updatedAt) {
      conflicts.push({ type: 'classroom', id: localC.id, local: localC, cloud: cloudC });
    }
  });
  return conflicts;
}

async function resolveConflicts(conflicts) {
  for (const conflict of conflicts) {
    // Show conflict resolution UI
    const resolution = await showConflictDialog(conflict);
    if (resolution === 'local') {
      // Keep local, will overwrite cloud
    } else if (resolution === 'cloud') {
      // Use cloud version
      const index = DB.classrooms.findIndex(c => c.id === conflict.id);
      if (index >= 0) {
        DB.classrooms[index] = conflict.cloud;
      }
    } else if (resolution === 'merge') {
      // Manual merge - show diff editor
      await showMergeEditor(conflict);
    }
  }
}

function queuePendingChanges(badge) {
  const entry = { timestamp: new Date().toISOString(), context: badge || 'unknown' };
  if (!DB.pendingChanges) DB.pendingChanges = [];
  // Keep max 50 pending entries to avoid unbounded growth
  DB.pendingChanges.push(entry);
  if (DB.pendingChanges.length > 50) DB.pendingChanges.shift();
  saveToLocalStorage();
}

function saveToLocalStorage() {
  try {
    // Save main
    localStorage.setItem('gj_v6_pro', JSON.stringify(DB));
    // Save backup
    localStorage.setItem('gj_v6_pro_backup', JSON.stringify(DB));
  } catch (e) {
    console.error('Failed to save to localStorage:', e);
  }
}

function updateSyncUI() {
  const syncIndicator = safeGetElement('sync-indicator');
  if (!syncIndicator) return;
  
  syncIndicator.className = `sync-indicator ${DB.syncStatus}`;
  syncIndicator.textContent = DB.syncStatus === 'syncing' ? '⟳ Syncing...' :
                             DB.syncStatus === 'error' ? '⚠️ Offline' :
                             DB.lastSync ? `✓ Synced ${timeAgo(DB.lastSync)}` : '';
}

function timeAgo(timestamp) {
  const seconds = Math.floor((new Date() - new Date(timestamp)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => {
    if (navigator.onLine && DB.user?.mode === 'supabase') {
      syncWithCloud();
    }
  }, SYNC_INTERVAL);
}

function stopAutoSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// ============================================
// SUPABASE DATA LOADING (BATCHED)
// ============================================
async function loadUserDataFromSupabase(userId) {
  try {
    // Batch load all data
    const [classrooms, settings] = await Promise.all([
      supabase.from('classrooms').select('*').eq('user_id', userId),
      supabase.from('export_settings').select('*').eq('user_id', userId).maybeSingle()
    ]);
    
    if (classrooms.error) throw classrooms.error;
    if (!classrooms.data || classrooms.data.length === 0) {
      return { classrooms: [] };
    }
    
    // Get all classroom IDs
    const classroomIds = classrooms.data.map(c => c.id);
    
    // Batch load all related data
    const [students, lessons, columns] = await Promise.all([
      supabase.from('students').select('*').in('classroom_id', classroomIds),
      supabase.from('lessons').select('*').in('classroom_id', classroomIds),
      supabase.from('columns').select('*').in('classroom_id', classroomIds)
    ]);
    
    if (students.error) throw students.error;
    if (lessons.error) throw lessons.error;
    if (columns.error) throw columns.error;
    
    // Create maps for efficient lookup
    const studentsByClassroom = new Map();
    students.data?.forEach(s => {
      if (!studentsByClassroom.has(s.classroom_id)) {
        studentsByClassroom.set(s.classroom_id, []);
      }
      studentsByClassroom.get(s.classroom_id).push(s);
    });
    
    const lessonsByClassroom = new Map();
    lessons.data?.forEach(l => {
      if (!lessonsByClassroom.has(l.classroom_id)) {
        lessonsByClassroom.set(l.classroom_id, []);
      }
      lessonsByClassroom.get(l.classroom_id).push(l);
    });
    
    const columnsByClassroom = new Map();
    columns.data?.forEach(col => {
      if (!columnsByClassroom.has(col.classroom_id)) {
        columnsByClassroom.set(col.classroom_id, []);
      }
      columnsByClassroom.get(col.classroom_id).push(col);
    });
    
    // Get all lesson IDs
    const lessonIds = lessons.data?.map(l => l.id) || [];
    
    // Batch load grades and attendance for all lessons
    let grades = [];
    let attendance = [];
    
    if (lessonIds.length > 0) {
      // Process in batches to avoid URL length limits
      for (let i = 0; i < lessonIds.length; i += BATCH_SIZE) {
        const batch = lessonIds.slice(i, i + BATCH_SIZE);
        const [gradesBatch, attendanceBatch] = await Promise.all([
          supabase.from('grades').select('*').in('lesson_id', batch),
          supabase.from('attendance').select('*').in('lesson_id', batch)
        ]);
        
        if (gradesBatch.error) throw gradesBatch.error;
        if (attendanceBatch.error) throw attendanceBatch.error;
        
        grades = grades.concat(gradesBatch.data || []);
        attendance = attendance.concat(attendanceBatch.data || []);
      }
    }
    
    // Create maps for grades and attendance
    const gradesByLesson = new Map();
    grades.forEach(g => {
      if (!gradesByLesson.has(g.lesson_id)) {
        gradesByLesson.set(g.lesson_id, []);
      }
      gradesByLesson.get(g.lesson_id).push(g);
    });
    
    const attendanceByLesson = new Map();
    attendance.forEach(a => {
      if (!attendanceByLesson.has(a.lesson_id)) {
        attendanceByLesson.set(a.lesson_id, []);
      }
      attendanceByLesson.get(a.lesson_id).push(a);
    });
    
    // Build classroom objects
    const cloudClassrooms = classrooms.data.map(c => {
      const classroomStudents = studentsByClassroom.get(c.id) || [];
      const classroomLessons = lessonsByClassroom.get(c.id) || [];
      const classroomColumns = columnsByClassroom.get(c.id) || [];
      
      // Build lessons with data
      const lessonsWithData = classroomLessons.map(l => {
        const lessonGrades = gradesByLesson.get(l.id) || [];
        const lessonAttendance = attendanceByLesson.get(l.id) || [];
        
        const data = {};
        
        lessonGrades.forEach(g => {
          if (g.column_id) {
            data[`col_${g.column_id}_${g.student_id}`] = g.grade;
          }
        });
        
        lessonAttendance.forEach(a => {
          data[`att_${a.student_id}`] = a.status;
        });
        
        return {
          id: l.lesson_number,
          topic: l.title,
          date: l.lesson_date,
          num: l.lesson_number,
          mode: l.mode,
          studentIds: l.student_ids || [],
          data,
          updatedAt: l.updated_at
        };
      });
      
      return {
        id: c.id, // Keep UUID as string, don't parse to int
        name: c.name,
        subject: c.subject || '',
        teacher: c.teacher_name || '',
        students: classroomStudents.map(s => ({
          id: s.student_number,
          name: s.name,
          phone: s.phone || '',
          email: s.email || '',
          parentName: s.parent_name || '',
          parentPhone: s.parent_phone || '',
          note: s.notes || '',
          updatedAt: s.updated_at
        })),
        lessons: lessonsWithData,
        columns: classroomColumns.map(col => ({
          id: col.column_number,
          name: col.name,
          ielts: col.ielts || false,
          lessonId: col.lesson_id ? classroomLessons.find(l => l.id === col.lesson_id)?.lesson_number : null
        })),
        nextSid: c.next_student_id,
        nextLid: c.next_lesson_id,
        nextCid: c.next_column_id,
        updatedAt: c.updated_at
      };
    });
    
    // Load export settings
    let exportSettings = DB.exportSettings;
    if (settings.data) {
      exportSettings = {
        color: settings.data.color || { h: 30, s: 60, l: 50, a: 100 },
        logo: settings.data.logo_data || null,
        logoName: settings.data.logo_name || null,
        logoSize: settings.data.logo_size || null
      };
    }
    
    return {
      classrooms: cloudClassrooms,
      exportSettings,
      nextId: Math.max(...cloudClassrooms.map(c => parseInt(c.id.split('-')[0]) || 0), 0) + 1
    };
    
  } catch (e) {
    console.error('Error loading from Supabase:', e);
    throw e;
  }
}

// ============================================
// SUPABASE DATA SAVING (WITH TRANSACTIONS)
// ============================================
async function saveUserDataToSupabase(userId) {
  if (!supabase) throw new Error('Supabase not initialized');
  
  const errors = [];
  const operations = [];
  
  try {
    // Start by clearing existing data (in a transaction if possible)
    operations.push(
      () => supabase.from('classrooms').delete().eq('user_id', userId)
    );
    
    // Save each classroom
    for (const c of DB.classrooms) {
      // Insert classroom
      operations.push(async () => {
        const { data, error } = await supabase
          .from('classrooms')
          .insert({
            user_id: userId,
            name: c.name,
            subject: c.subject,
            teacher_name: c.teacher,
            next_student_id: c.nextSid,
            next_lesson_id: c.nextLid,
            next_column_id: c.nextCid
          })
          .select()
          .single();
          
        if (error) throw error;
        return { type: 'classroom', data, originalId: c.id };
      });
    }
    
    // Execute all operations and collect results
    const results = [];
    for (const op of operations) {
      try {
        const result = await op();
        results.push(result);
      } catch (error) {
        errors.push(error);
        console.error('Operation failed:', error);
      }
    }
    
    // Get mapping between original IDs and new UUIDs
    const classroomMap = new Map();
    results
      .filter(r => r?.type === 'classroom')
      .forEach(r => classroomMap.set(r.originalId, r.data.id));
    
    // Save students, lessons, etc. in batches
    await saveClassroomsData(userId, classroomMap, errors);
    
    // Save export settings
    try {
      await supabase
        .from('export_settings')
        .upsert({
          user_id: userId,
          logo_data: DB.exportSettings.logo ? DB.exportSettings.logo.substring(0, 500000) : null, // Limit size
          logo_name: DB.exportSettings.logoName,
          logo_size: DB.exportSettings.logoSize,
          color: DB.exportSettings.color
        });
    } catch (error) {
      errors.push(error);
    }
    
    if (errors.length > 0) {
      console.error('Some saves failed:', errors);
      showToast(`⚠️ ${errors.length} items failed to sync`);
    } else {
      showToast('✅ All data saved to cloud');
    }
    
  } catch (error) {
    console.error('Fatal error saving to Supabase:', error);
    throw error;
  }
}

async function saveClassroomsData(userId, classroomMap, errors) {
  const studentBatch = [];
  const lessonBatch = [];
  const columnBatch = [];
  const gradeBatch = [];
  const attendanceBatch = [];
  
  for (const c of DB.classrooms) {
    const classroomUuid = classroomMap.get(c.id);
    if (!classroomUuid) continue;
    
    // Students
    c.students.forEach(s => {
      studentBatch.push({
        classroom_id: classroomUuid,
        student_number: s.id,
        name: s.name,
        phone: s.phone || '',
        email: s.email || '',
        parent_name: s.parentName || '',
        parent_phone: s.parentPhone || '',
        notes: s.note || ''
      });
    });
    
    // Lessons
    c.lessons.forEach(l => {
      lessonBatch.push({
        classroom_id: classroomUuid,
        lesson_number: l.id,
        title: l.topic,
        lesson_date: l.date,
        mode: l.mode || 'standard',
        student_ids: l.studentIds || []
      });
    });
    
    // Columns
    c.columns.forEach(col => {
      const lesson = c.lessons.find(l => l.id === col.lessonId);
      columnBatch.push({
        classroom_id: classroomUuid,
        lesson_id: lesson ? null : null, // Would need lesson UUID mapping
        column_number: col.id,
        name: col.name,
        ielts: col.ielts || false
      });
    });
  }
  
  // Batch insert students
  if (studentBatch.length > 0) {
    try {
      const { data: students } = await supabase
        .from('students')
        .insert(studentBatch)
        .select();
      
      // Create student number to UUID map
      const studentMap = new Map();
      students?.forEach(s => {
        studentMap.set(s.student_number, s.id);
      });
      
      // Batch insert lessons
      if (lessonBatch.length > 0) {
        const { data: lessons } = await supabase
          .from('lessons')
          .insert(lessonBatch)
          .select();
        
        // Create lesson number to UUID map
        const lessonMap = new Map();
        lessons?.forEach(l => {
          lessonMap.set(l.lesson_number, l.id);
        });
        
        // Prepare grades and attendance
        DB.classrooms.forEach(c => {
          c.lessons.forEach(l => {
            const lessonUuid = lessonMap.get(l.id);
            if (!lessonUuid) return;
            
            Object.entries(l.data || {}).forEach(([key, value]) => {
              if (key.startsWith('col_')) {
                const [, colId, studentId] = key.split('_');
                const studentUuid = studentMap.get(parseInt(studentId));
                if (studentUuid) {
                  gradeBatch.push({
                    lesson_id: lessonUuid,
                    student_id: studentUuid,
                    column_id: null, // Would need column UUID
                    grade: value
                  });
                }
              } else if (key.startsWith('att_')) {
                const studentId = key.split('_')[1];
                const studentUuid = studentMap.get(parseInt(studentId));
                if (studentUuid) {
                  attendanceBatch.push({
                    lesson_id: lessonUuid,
                    student_id: studentUuid,
                    status: value
                  });
                }
              }
            });
          });
        });
      }
    } catch (error) {
      errors.push(error);
    }
  }
  
  // Batch insert grades and attendance
  if (gradeBatch.length > 0) {
    try {
      await supabase.from('grades').insert(gradeBatch);
    } catch (error) {
      errors.push(error);
    }
  }
  
  if (attendanceBatch.length > 0) {
    try {
      await supabase.from('attendance').insert(attendanceBatch);
    } catch (error) {
      errors.push(error);
    }
  }
}

// ============================================
// SAVE DB (with debounce and offline queue)
// ============================================
let _st;
let saveQueue = [];

async function saveDB(badge, immediate = false) {
  // Add to queue
  saveQueue.push({ badge, timestamp: Date.now() });
  
  const saveOperation = async () => {
    try {
      // Always save to localStorage
      saveToLocalStorage();
      
      // If online and logged in, save to cloud
      if (navigator.onLine && supabase && DB.user?.mode === 'supabase' && DB.user?.id) {
        try {
          await saveUserDataToSupabase(DB.user.id);
          DB.pendingChanges = [];
        } catch (error) {
          console.error('Cloud save failed, queuing for later:', error);
          queuePendingChanges(badge);
        }
      } else if (DB.user?.mode === 'supabase') {
        // Offline - queue for later
        const lastBadge = saveQueue[saveQueue.length - 1]?.badge;
        queuePendingChanges(lastBadge);
      }
      
      // Show save indicator
      const lastBadge = saveQueue[saveQueue.length - 1]?.badge;
      if (lastBadge) showSave(lastBadge);
      
    } catch (e) {
      console.error('Failed to save DB', e);
    }
    
    saveQueue = [];
  };
  
  if (immediate) {
    clearTimeout(_st);
    await saveOperation();
  } else {
    clearTimeout(_st);
    _st = setTimeout(saveOperation, 150);
  }
}

function showSave(badge) {
  const el = safeGetElement('save-pill-' + badge);
  if (!el) return;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

// ============================================
// OFFLINE DETECTION
// ============================================
// Online/offline events are set up in DOMContentLoaded


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
function showAuth(mode) { 
  showScreen('s-auth'); 
  if (mode) authSwitchTab(mode);
  loadAuthLogo();
}
function goHome() { showScreen('s-home'); renderClassrooms(); }
function goBackToClass() { showScreen('s-classroom'); switchTab('students', document.querySelector('[data-tab="students"]')); }
function showContact() { showScreen('s-contact'); }

// ============================================
// AUTH LOGO MANAGEMENT
// ============================================
function loadAuthLogo() {
  const logoContainer = safeGetElement('auth-logo-container');
  if (!logoContainer) return;
  
  if (DB.exportSettings && DB.exportSettings.logo) {
    logoContainer.innerHTML = `<img src="${DB.exportSettings.logo}" alt="School Logo" class="auth-logo-img" loading="lazy">`;
  } else {
    logoContainer.innerHTML = `
      <div class="logo-fallback">GJ</div>
      <p>Your School Logo</p>
    `;
  }
}

// ============================================
// AUTHENTICATION (with merge strategy)
// ============================================
let _authMode = 'signin';
function authSwitchTab(mode) {
  _authMode = mode;
  
  // Safe element access with checks
  const tabSignin = safeGetElement('tab-signin');
  const tabSignup = safeGetElement('tab-signup');
  const authTrack = safeGetElement('auth-track');
  const authTagline = safeGetElement('auth-tagline');
  const errSignin = safeGetElement('err-signin');
  const errSignup = safeGetElement('err-signup');
  
  if (tabSignin) tabSignin.classList.toggle('active', mode === 'signin');
  if (tabSignup) tabSignup.classList.toggle('active', mode === 'signup');
  if (authTrack) authTrack.classList.toggle('show-signup', mode === 'signup');
  if (authTagline) {
    authTagline.textContent = mode === 'signin' 
      ? 'Welcome back — log in to continue' 
      : 'Create your free teacher account';
  }
  if (errSignin) errSignin.classList.remove('show');
  if (errSignup) errSignup.classList.remove('show');
}

function authErr(id, msg) {
  const el = safeGetElement(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
}

async function authSubmit(mode) {
  if (mode === 'signin') {
    const email = safeGetElement('si-email')?.value.trim();
    const pass = safeGetElement('si-password')?.value;
    
    if (!email || !pass) { 
      authErr('err-signin', 'Please fill in all fields.'); 
      return; 
    }
    
    if (pass.length < 6) { 
      authErr('err-signin', 'Password must be at least 6 characters.'); 
      return; 
    }
    
    authErr('err-signin', '');
    
    if (supabase) {
      try {
        // Save current local data as guest data before login
        const guestData = { ...DB };
        
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password: pass
        });
        
        if (error) {
          // Check if it's a CORS or network error
          if (error.message.includes('Network error') || error.message.includes('Failed to fetch')) {
            authErr('err-signin', 'Unable to connect to authentication server. Please check your internet connection or try again later.');
          } else {
            authErr('err-signin', error.message);
          }
          return;
        }
        
        const user = data.user;
        
        // Load cloud data with error handling
        let cloudData = { classrooms: [] };
        try {
          cloudData = await loadUserDataFromSupabase(user.id);
        } catch (loadError) {
          console.warn('Could not load cloud data, using local only:', loadError);
          // Continue with empty cloud data
        }
        
        // Merge guest data with cloud data
        DB = mergeData(guestData, cloudData, 'timestamp');
        
        // Set user
        DB.user = { 
          id: user.id,
          email: user.email, 
          name: user.user_metadata?.full_name || user.email.split('@')[0], 
          mode: 'supabase' 
        };
        
        // Save merged data everywhere
        await saveDB('home', true);
        
        // Start auto-sync
        startAutoSync();
        
        enterApp();
        
      } catch (err) {
        console.error('Auth error:', err);
        authErr('err-signin', 'Authentication failed. Please try again.');
      }
      return;
    }
    
    // Fallback to local mode
    DB.user = { email, name: email.split('@')[0], mode: 'local' };
    saveDB('home', true);
    enterApp();
  } else if (mode === 'signup') {
    // Handle signup
    const name = safeGetElement('su-name')?.value.trim();
    const email = safeGetElement('su-email')?.value.trim();
    const pass = safeGetElement('su-password')?.value;
    
    if (!name || !email || !pass) {
      authErr('err-signup', 'Please fill in all fields.');
      return;
    }
    
    if (pass.length < 6) {
      authErr('err-signup', 'Password must be at least 6 characters.');
      return;
    }
    
    authErr('err-signup', '');
    
    if (supabase) {
      try {
        const { data, error } = await supabase.auth.signUp({
          email,
          password: pass,
          options: {
            data: {
              full_name: name
            }
          }
        });
        
        if (error) {
          if (error.message.includes('Network error')) {
            authErr('err-signup', 'Network error. Please check your connection.');
          } else {
            authErr('err-signup', error.message);
          }
          return;
        }
        
        showToast('✅ Account created! Please check your email to confirm.');
        authSwitchTab('signin');
        
      } catch (err) {
        console.error('Signup error:', err);
        authErr('err-signup', 'Signup failed. Please try again.');
      }
    }
  } else if (mode === 'guest') {
    // Guest mode
    DB.user = { 
      name: 'Guest', 
      email: 'guest@local', 
      mode: 'local',
      id: 'guest_' + Date.now()
    };
    saveDB('home', true);
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
  
  // Add sync indicator to topbar
  addSyncIndicator();
  
  checkOnboarding();
}

function addSyncIndicator() {
  const topbarRight = document.querySelector('.topbar-right');
  if (topbarRight && !safeGetElement('sync-indicator')) {
    const indicator = document.createElement('div');
    indicator.id = 'sync-indicator';
    indicator.className = 'sync-indicator idle';
    topbarRight.prepend(indicator);
    updateSyncUI();
  }
}

async function signOut() {
  // Stop auto-sync
  stopAutoSync();
  
  // Save any pending changes
  await saveDB('home', true);
  
  if (supabase && DB.user?.mode === 'supabase') {
    await supabase.auth.signOut();
  }
  
  // Keep a copy in localStorage but clear user
  const userData = { ...DB };
  localStorage.setItem('gj_v6_pro_last_user', JSON.stringify(userData));
  
  DB.user = null;
  DB.syncStatus = 'idle';
  
  saveToLocalStorage();
  
  closeOv('ov-user');
  showLanding();
}

// ============================================
// ONBOARDING
// ============================================
function checkOnboarding() {
  if (DB.user && !DB.user.onboardingCompleted) {
    if (DB.user.name) {
      const nameInput = safeGetElement('onboarding-name');
      if (nameInput) nameInput.value = DB.user.name;
    }
    if (DB.user.school) {
      const schoolInput = safeGetElement('onboarding-school');
      if (schoolInput) schoolInput.value = DB.user.school;
    }
    if (DB.user.role) {
      const roleSelect = safeGetElement('onboarding-role');
      if (roleSelect) roleSelect.value = DB.user.role;
    }
    
    setTimeout(() => {
      openOv('ov-onboarding');
    }, 500);
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
  
  if (!name) {
    shake('onboarding-name');
    return;
  }
  
  DB.user.name = name;
  DB.user.school = school;
  DB.user.role = role;
  DB.user.onboardingCompleted = true;
  
  safeSetText('user-name-display', name);
  safeSetText('user-av', name.slice(0, 2).toUpperCase());
  safeSetText('um-name', name);
  
  const h = new Date().getHours();
  safeSetText('home-greeting', 
    (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + name.split(' ')[0] + ' 👋');
  
  if (supabase && DB.user?.mode === 'supabase' && DB.user?.id) {
    await supabase
      .from('profiles')
      .upsert({
        id: DB.user.id,
        full_name: name,
        school_name: school,
        role: role,
        onboarding_completed: true
      });
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
  const welcomeCard = document.querySelector('.welcome-card');
  if (welcomeCard) welcomeCard.remove();

  DB.classrooms.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'classroom-card fade-up';
    card.style.animationDelay = (i * .05) + 's';
    const baseIndex = Number.isFinite(Number(c.id)) ? Number(c.id) : i;
    const icon = CC_ICONS[Math.abs(baseIndex) % CC_ICONS.length] || '📚';
    const studentCount = Array.isArray(c.students) ? c.students.length : 0;
    const lessonCount = Array.isArray(c.lessons) ? c.lessons.length : 0;
    const columnCount = Array.isArray(c.columns) ? c.columns.length : 0;
    card.innerHTML = `<div class="cc-header"><div class="cc-icon">${icon}</div><button class="cc-del" onclick="event.stopPropagation();deleteClassConfirm('${c.id}')"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button></div>
      <div class="cc-name">${esc(c.name)}</div><div class="cc-subject">${esc(c.subject || '')}${c.teacher ? ' · ' + esc(c.teacher) : ''}</div>
      <div class="cc-stats"><div><div class="cc-stat-val">${studentCount}</div><div class="cc-stat-lbl">Students</div></div><div><div class="cc-stat-val">${lessonCount}</div><div class="cc-stat-lbl">Lessons</div></div><div><div class="cc-stat-val">${columnCount}</div><div class="cc-stat-lbl">Columns</div></div></div>`;
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

function createClassroom() {
  const nameInput = safeGetElement('inp-cname');
  if (!nameInput) return;
  
  const name = nameInput.value.trim();
  if (!name) { shake('inp-cname'); return; }
  
  const subjectInput = safeGetElement('inp-csub');
  const teacherInput = safeGetElement('inp-cteacher');
  
  const newClass = {
    id: `class_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`, // Use string ID
    name,
    subject: subjectInput ? subjectInput.value.trim() : '',
    teacher: teacherInput ? teacherInput.value.trim() : '',
    students: [],
    columns: [],
    lessons: [],
    nextSid: 1,
    nextLid: 1,
    nextCid: 1,
    updatedAt: new Date().toISOString()
  };
  
  DB.classrooms.push(newClass);
  DB.nextId = Math.max(DB.nextId, parseInt(newClass.id.split('_')[1] || '0') + 1);
  
  rebuildIndex();
  saveDB('home');
  closeOv('ov-new-class');
  clrInputs(['inp-cname', 'inp-csub', 'inp-cteacher']);
  renderClassrooms();
  toast('Classroom created!');
}

function deleteClassConfirm(id) {
  const c = getC(id);
  if (!c) return;
  
  confirm_(`Delete "${c.name}"?`, 'All students, lessons, and grades will be permanently deleted.', () => {
    DB.classrooms = DB.classrooms.filter(c => c.id !== id);
    rebuildIndex();
    saveDB('home', true);
    renderClassrooms();
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
  
  const phoneInput = safeGetElement('inp-sphone');
  const emailInput = safeGetElement('inp-semail');
  const pnameInput = safeGetElement('inp-pname');
  const pphoneInput = safeGetElement('inp-pphone');
  const noteInput = safeGetElement('inp-snote');
  
  const data = {
    name,
    phone: phoneInput ? phoneInput.value.trim() : '',
    email: emailInput ? emailInput.value.trim() : '',
    parentName: pnameInput ? pnameInput.value.trim() : '',
    parentPhone: pphoneInput ? pphoneInput.value.trim() : '',
    note: noteInput ? noteInput.value.trim() : '',
    updatedAt: new Date().toISOString()
  };
  
  const c = CC();
  if (!c) return;
  
  if (editSid !== null) {
    const student = c.students.find(s => s.id === editSid);
    if (student) {
      Object.assign(student, data);
    }
    toast('Student updated!');
  } else {
    const newId = c.nextSid++;
    c.students.push({ id: newId, ...data });
    toast('Student added!');
  }
  
  rebuildIndex();
  saveDB('class');
  closeOv('ov-student');
  renderStudents();
  
  const sheetOv = safeGetElement('sheet-ov');
  if (sheetOv && sheetOv.classList.contains('open')) {
    openStudentSheet(editSid || c.students[c.students.length - 1].id);
  }
}

function studentStats(sid) {
  const c = CC();
  if (!c) return { present: 0, late: 0, absent: 0, attended: 0, total: 0 };
  
  let present = 0, late = 0, absent = 0;
  
  c.lessons.forEach(l => {
    if (l.studentIds && !l.studentIds.includes(sid)) {
      return;
    }
    
    const val = (l.data || {})[`att_${sid}`] || 'present';
    if (val === 'present') present++;
    else if (val === 'late') late++;
    else absent++;
  });
  
  return { 
    present, 
    late, 
    absent, 
    attended: present + late, 
    total: c.lessons.filter(l => !l.studentIds || l.studentIds.includes(sid)).length 
  };
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
    const el = document.createElement('div');
    el.className = 'student-item fade-up';
    el.style.animationDelay = (i * .04) + 's';
    el.innerHTML = `<div class="s-avatar">${esc(initials)}</div>
      <div class="s-info"><div class="s-name">${esc(s.name)}</div>
        <div class="s-meta">${s.phone ? `<span class="s-meta-item">📱 ${esc(s.phone)}</span>` : ''}${s.parentPhone ? `<span class="s-meta-item">👨‍👩‍👧 ${esc(s.parentPhone)}</span>` : ''}${s.note ? `<span class="s-meta-item">📝 ${esc(s.note)}</span>` : ''}</div></div>
      <div class="s-att-pills">${st.total > 0 ? `<span class="pill pill-green">✓ ${st.present}</span>${st.late > 0 ? `<span class="pill pill-amber">⏰ ${st.late}</span>` : ''}${st.absent > 0 ? `<span class="pill pill-red">✗ ${st.absent}</span>` : ''}` :
        '<span style="font-size:11px;color:var(--text-light)">No lessons</span>'}</div>
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
    c.students = c.students.filter(s => s.id !== sid);
    rebuildIndex();
    saveDB('class', true);
    renderStudents();
    toast('Student removed.');
  });
}

// STUDENT SHEET
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
        ${icard(sid, 'name', 'Name', s.name)}
        ${icard(sid, 'phone', 'Student Phone', s.phone || '')}
        ${icard(sid, 'email', 'Email', s.email || '')}
        ${icard(sid, 'parentName', 'Parent / Guardian', s.parentName || '')}
        ${icard(sid, 'parentPhone', 'Parent Phone', s.parentPhone || '')}
        ${icard(sid, 'note', 'Notes', s.note || '')}
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
  inp.focus();
  inp.select();
  
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
    if (e.key === 'Escape') { 
      card.classList.remove('editing'); 
      valDiv.innerHTML = cur ? esc(cur) : '<span class="empty">—</span>'; 
    }
  };
  inp.onblur = commit;
}

function closeSheet() { 
  const sheetOv = safeGetElement('sheet-ov');
  if (sheetOv) sheetOv.classList.remove('open'); 
}

function closeSheetIfBg(e) { 
  if (e.target === safeGetElement('sheet-ov')) closeSheet(); 
}

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

  const lesson = { 
    id: c.nextLid++, 
    topic, 
    date, 
    num, 
    data: {}, 
    mode: currentLessonMode,
    studentIds: c.students.map(s => s.id),
    updatedAt: new Date().toISOString()
  };

  if (currentLessonMode === 'ielts') {
    IELTS_SECTIONS.forEach(sec => {
      if (sec !== 'Overall Band') {
        c.columns.push({ 
          id: c.nextCid++, 
          name: sec, 
          ielts: true, 
          lessonId: lesson.id,
          updatedAt: new Date().toISOString()
        });
      }
    });
  }

  c.lessons.push(lesson);
  LID = lesson.id;
  
  rebuildIndex();
  saveDB('class');
  closeOv('ov-lesson');
  renderLessons();
  
  const tbadge = safeGetElement('tbadge-lessons');
  if (tbadge) tbadge.textContent = c.lessons.length;
  toast(currentLessonMode === 'ielts' ? '🎯 IELTS lesson created!' : 'Lesson created!');
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
  if (dateInput && dateInput.value) l.date = dateInput.value;
  
  const numInput = safeGetElement('inp-el-num');
  if (numInput && numInput.value) l.num = parseInt(numInput.value) || l.num;
  
  l.updatedAt = new Date().toISOString();
  
  saveDB('class');
  closeOv('ov-edit-lesson');
  renderLessons();
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
    
    const el = document.createElement('div');
    el.className = 'lesson-item fade-up' + (l.mode === 'ielts' ? ' ielts-lesson' : '');
    el.style.animationDelay = (i * .04) + 's';
    const status = lessonCompletionStatus(l, c);
    const statusDot = status === 'complete' ? '<span class="lesson-status-dot complete" title="All grades filled">●</span>'
      : status === 'partial' ? '<span class="lesson-status-dot partial" title="Some grades missing">◑</span>'
      : status === 'att-only' ? '<span class="lesson-status-dot att-only" title="Attendance only">○</span>'
      : '';
    el.innerHTML = `<div class="lesson-number">${l.num || i + 1}</div>
      <div class="lesson-info">
        <div class="lesson-name">${esc(l.topic)}${l.mode === 'ielts' ? '<span class="ielts-badge" style="margin-left:8px">🎯 IELTS</span>' : ''}${statusDot}</div>
        <div class="lesson-date-row"><svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span>${l.date}</span><span style="color:var(--border)">·</span><span>${l.studentIds ? l.studentIds.length : c.students.length} students</span></div></div>
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
  
  confirm_(`Delete lesson "${l.topic}"?`, 'All attendance and grade data for this lesson will be lost.', () => {
    const c = CC();
    if (!c) return;
    c.columns = c.columns.filter(col => col.lessonId !== lid);
    c.lessons = c.lessons.filter(l => l.id !== lid);
    
    if (LID === lid) LID = null;
    
    rebuildIndex();
    saveDB('class', true);
    renderLessons();
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
  if (addColBtn) {
    if (l.mode === 'ielts') {
      addColBtn.style.display = 'none';
    } else {
      addColBtn.style.display = 'inline-flex';
    }
  }
  
  renderLessonHeader();
  renderGradebook();
  showScreen('s-lesson');
}

function renderLessonHeader() {
  const l = CL();
  if (!l) return;
  
  const c = CC();
  if (!c) return;
  
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
  
  if (l.studentIds && !l.studentIds.includes(sid)) {
    return '-';
  }

  const cols = c.columns.filter(col => col.ielts && col.lessonId === l.id && col.name !== 'Overall Band');
  let sum = 0, count = 0;

  cols.forEach(col => {
    const val = (l.data || {})[`col_${col.id}_${sid}`];
    if (val && val.trim()) {
      const n = parseFloat(val);
      if (!isNaN(n)) { sum += n; count++; }
    }
  });

  if (count === 0) return '-';
  const avg = sum / count;
  return avg.toFixed(1);
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
      <div class="stat-chip"><div class="stat-chip-dot" style="background:var(--accent)"></div>Attendance Rate: ${rate}%</div>
      <div class="stat-chip">Total Students: ${total}</div>`;
  }

  const lessonCols = l.mode === 'ielts' ? c.columns.filter(col => col.ielts && col.lessonId === l.id) : c.columns.filter(col => !col.ielts);

  const head = safeGetElement('gb-head');
  if (head) {
    head.innerHTML = `<tr>
      <th class="th-student">Student</th>
      <th style="width:130px">Attendance</th>
      ${lessonCols.map(col => {
        if (col.name === 'Overall Band') {
          return `<th class="overall-band-col" style="min-width:120px"><div class="th-inner-flex"><span>⭐ Overall Band</span></div></th>`;
        }
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
          <button class="att-opt ${attVal === 'present' ? 'active-p' : ''}" onclick="setAtt(${s.id},'present')" title="Present">✓</button>
          <button class="att-opt ${attVal === 'late' ? 'active-l' : ''}" onclick="setAtt(${s.id},'late')" title="Late">⏰</button>
          <button class="att-opt ${attVal === 'absent' ? 'active-a' : ''}" onclick="setAtt(${s.id},'absent')" title="Absent">✗</button>
        </div>
      </td>
      ${lessonCols.map(col => {
        if (col.name === 'Overall Band') {
          const overall = calculateOverallBand(s.id);
          return `<td class="overall-band-cell">${overall}</td>`;
        }
        const val = esc((l.data || {})[`col_${col.id}_${s.id}`] || '');
        if (l.mode === 'ielts' && col.ielts) {
          const bandClass = getBandClass(val);
          return `<td class="band-score-cell"><input class="grade-inp" type="text" placeholder="—" value="${val}" onchange="saveGrade(${col.id},${s.id},this.value)" style="text-align:center" ${absent ? 'disabled' : ''}></td>`;
        }
        return `<td><input class="grade-inp" type="text" placeholder="—" value="${val}" onchange="saveGrade(${col.id},${s.id},this.value)" ${absent ? 'disabled' : ''}></td>`;
      }).join('')}`;
    body.appendChild(tr);
  });

  const addTr = document.createElement('tr');
  addTr.className = 'add-student-row';
  addTr.innerHTML = `<td class="td-student" colspan="${2 + lessonCols.length}"><input class="add-row-inp" placeholder="+ Type student name and press Enter to add to THIS lesson..." onkeydown="if(event.key==='Enter')quickAddStudentToLesson(this.value)"></td>`;
  body.appendChild(addTr);

  // Keyboard navigation: Tab/Enter moves between grade inputs
  setupGradebookKeyNav();
}

function cycleAtt(sid) {
  const l = CL();
  if (!l) return;
  const key = `att_${sid}`;
  const cur = (l.data || {})[key] || 'present';
  const next = { present: 'late', late: 'absent', absent: 'present' };
  if (!l.data) l.data = {};
  l.data[key] = next[cur];
  l.updatedAt = new Date().toISOString();
  saveDB('lesson');
  renderGradebook();
  renderStudents();
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
  if (l.mode === 'ielts') {
    renderGradebook();
  }
}

function quickAddStudentToLesson(name) {
  name = name.trim();
  if (!name) return;
  
  const c = CC();
  const l = CL();
  
  if (!c || !l) return;
  
  const newStudent = { 
    id: c.nextSid++, 
    name, 
    phone: '', 
    email: '', 
    parentName: '', 
    parentPhone: '', 
    note: '',
    updatedAt: new Date().toISOString()
  };
  c.students.push(newStudent);
  
  if (l.studentIds) {
    l.studentIds.push(newStudent.id);
  }
  
  l.updatedAt = new Date().toISOString();
  
  rebuildIndex();
  saveDB('class');
  renderGradebook();
  renderStudents();
  toast(`✅ Student added to this lesson and class roster!`);
}

// ============================================
// COLUMNS
// ============================================
function openAddColumn() {
  const colInput = safeGetElement('inp-colname');
  if (colInput) colInput.value = '';
  openOv('ov-column');
}

function saveColumn() {
  const colInput = safeGetElement('inp-colname');
  if (!colInput) return;
  
  const name = colInput.value.trim();
  if (!name) { shake('inp-colname'); return; }
  
  const c = CC();
  if (!c) return;
  
  c.columns.push({ 
    id: c.nextCid++, 
    name,
    updatedAt: new Date().toISOString()
  });
  
  rebuildIndex();
  saveDB('class');
  closeOv('ov-column');
  renderGradebook();
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
  
  col.name = name;
  col.updatedAt = new Date().toISOString();
  
  saveDB('class');
  closeOv('ov-rename-col');
  renderGradebook();
  toast('Column renamed!');
}

function delColumnConfirm(cid) {
  const col = getColumn(CID, cid);
  if (!col) return;
  
  confirm_(`Delete column "${col.name}"?`, 'All grades in this column will be permanently deleted.', () => {
    const c = CC();
    if (!c) return;
    c.columns = c.columns.filter(c => c.id !== cid);
    rebuildIndex();
    saveDB('class', true);
    renderGradebook();
    toast('Column deleted.');
  });
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
    totalP += st.present; 
    totalL += st.late; 
    totalA += st.absent;
    totalLessons += st.total;
    
    const rate = st.total > 0 ? Math.round(st.attended / st.total * 100) : 100;
    const rateColor = rate >= 80 ? 'var(--success)' : rate >= 60 ? 'var(--warning)' : 'var(--error)';
    return { 
      name: s.name, 
      rate, 
      attended: st.attended, 
      total: st.total, 
      rateColor, 
      present: st.present, 
      late: st.late, 
      absent: st.absent 
    };
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

  // Render chart after DOM update
  requestAnimationFrame(() => {
    const canvas = safeGetElement('att-chart');
    if (!canvas || !window.Chart) return;

    // Destroy existing chart if any
    const existingChart = Chart.getChart(canvas);
    if (existingChart) existingChart.destroy();

    const labels = rows.map(r => r.name.split(' ')[0]);
    const data = rows.map(r => r.rate);
    const colors = rows.map(r => r.rate >= 80 ? 'rgba(90,138,90,0.8)' : r.rate >= 60 ? 'rgba(184,112,32,0.8)' : 'rgba(192,64,64,0.8)');

    new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Attendance %',
          data,
          backgroundColor: colors,
          borderRadius: 6,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${rows[ctx.dataIndex].name}: ${ctx.raw}% (${rows[ctx.dataIndex].attended}/${rows[ctx.dataIndex].total})`,
            },
          },
        },
        scales: {
          y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, grid: { color: 'rgba(0,0,0,0.05)' } },
          x: { grid: { display: false } },
        },
      },
    });
  });
}

// ============================================
// EXPORT FUNCTIONS
// ============================================
let currentExportContext = null;

function exportClass() {
  currentExportContext = { type: 'class', id: CID };
  openOv('ov-export');
}

function exportLesson() {
  currentExportContext = { type: 'lesson', id: LID };
  openOv('ov-export');
}

// ============================================
// SHARED EXPORT PAYLOAD BUILDER
// ============================================
function buildExportPayload(context) {
  const settings = DB.exportSettings || { color: { h: 30, s: 60, l: 50, a: 100 } };
  const col = settings.color || { h: 30, s: 60, l: 50, a: 100 };
  const accentColor = `hsl(${col.h}, ${col.s}%, 50%)`;
  const accentColorDark = `hsl(${col.h}, ${col.s}%, 35%)`;
  const accentColorLight = `hsl(${col.h}, ${col.s}%, 92%)`;

  if (context.type === 'lesson') {
    const lesson = CL();
    const classroom = CC();
    const cols = lesson.mode === 'ielts'
      ? classroom.columns.filter(col => col.ielts && col.lessonId === lesson.id)
      : classroom.columns.filter(col => !col.ielts);
    const students = [...classroom.students]
      .filter(s => lesson.studentIds ? lesson.studentIds.includes(s.id) : true)
      .sort((a, b) => a.name.localeCompare(b.name));
    const rows = students.map(s => ({
      studentName: s.name,
      attendance: (lesson.data || {})[`att_${s.id}`] || 'present',
      grades: cols.map(col => col.name === 'Overall Band'
        ? calculateOverallBand(s.id)
        : (lesson.data || {})[`col_${col.id}_${s.id}`] || ''),
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
    const rows = [...classroom.students]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(s => {
        const stats = studentStats(s.id);
        const rate = stats.total > 0 ? Math.round(stats.attended / stats.total * 100) : 100;
        return { name: s.name, phone: s.phone || '', email: s.email || '',
          parentName: s.parentName || '', parentPhone: s.parentPhone || '', attendanceRate: rate };
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
// PDF EXPORT — CLIENT-SIDE via jsPDF
// ============================================
async function exportPDF() {
  if (!currentExportContext) return;
  closeOv('ov-export');

  // Show progress
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

    // ── Parse accent color ──────────────────────────────────────────────────
    const colMatch = payload.accentColor.match(/hsl\((\d+),\s*(\d+)%,\s*50%\)/);
    let accentRGB = [193, 127, 58]; // default gold
    if (colMatch) {
      accentRGB = hslToRgbArr(+colMatch[1], +colMatch[2], 50);
    }
    const accentLightRGB = [
      Math.round(accentRGB[0] * 0.2 + 235),
      Math.round(accentRGB[1] * 0.2 + 220),
      Math.round(accentRGB[2] * 0.2 + 200),
    ].map(v => Math.min(255, v));

    // ── Header bar ──────────────────────────────────────────────────────────
    doc.setFillColor(...accentRGB);
    doc.rect(0, 0, W, 28, 'F');

    // Logo
    let logoX = 10;
    if (payload.logoData && payload.logoData.startsWith('data:image')) {
      try {
        doc.addImage(payload.logoData, 10, 3, 22, 22, '', 'FAST');
        logoX = 36;
      } catch (e) { logoX = 10; }
    }

    // Title text
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(payload.className, logoX, 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    if (payload.type === 'lesson') {
      doc.text(`${payload.lessonName}  ·  ${formatDateDisplay(payload.lessonDate)}  ·  Lesson ${payload.lessonNum || ''}`, logoX, 20);
    } else {
      doc.text(`Class Roster  ·  ${payload.teacherName}  ·  ${payload.subject}`, logoX, 20);
    }

    // Right side meta
    doc.setFontSize(8);
    doc.text(`Generated ${new Date().toLocaleDateString()}`, W - 10, 10, { align: 'right' });
    doc.text(payload.institutionName, W - 10, 17, { align: 'right' });

    // ── Stats strip ────────────────────────────────────────────────────────
    let yPos = 34;
    if (payload.type === 'lesson') {
      const present = payload.rows.filter(r => r.attendance === 'present').length;
      const late    = payload.rows.filter(r => r.attendance === 'late').length;
      const absent  = payload.rows.filter(r => r.attendance === 'absent').length;
      const total   = payload.rows.length;
      const rate    = total > 0 ? Math.round(((present + late) / total) * 100) : 100;

      const stats = [
        { label: 'Students', val: String(total) },
        { label: 'Attendance', val: `${rate}%` },
        { label: 'Present', val: String(present) },
        { label: 'Late', val: String(late) },
        { label: 'Absent', val: String(absent) },
      ];
      const sw = (W - 20) / stats.length;
      stats.forEach((s, i) => {
        const sx = 10 + i * sw;
        doc.setFillColor(...accentLightRGB);
        doc.roundedRect(sx, yPos, sw - 3, 16, 2, 2, 'F');
        doc.setTextColor(...accentRGB);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.text(s.val, sx + (sw - 3) / 2, yPos + 8, { align: 'center' });
        doc.setTextColor(160, 128, 96);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7);
        doc.text(s.label.toUpperCase(), sx + (sw - 3) / 2, yPos + 13, { align: 'center' });
      });
      yPos += 22;
    }

    // ── Table ──────────────────────────────────────────────────────────────
    const colNames = payload.type === 'lesson'
      ? ['Student', 'Attendance', ...payload.columns]
      : ['Student', 'Phone', 'Email', 'Parent / Guardian', 'Attendance Rate'];

    const colWidths = payload.type === 'lesson'
      ? (() => {
          const gradeW = payload.columns.length > 0 ? Math.min(18, (W - 20 - 58 - 30) / payload.columns.length) : 18;
          return [58, 30, ...payload.columns.map(() => gradeW)];
        })()
      : [55, 35, 60, 50, 30];

    const tableW = colWidths.reduce((a, b) => a + b, 0);
    const startX = (W - tableW) / 2;
    const rowH = 8;

    // Header
    doc.setFillColor(...accentRGB);
    doc.rect(startX, yPos, tableW, 9, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    let cx = startX;
    colNames.forEach((name, i) => {
      doc.text(name, cx + 2, yPos + 6);
      cx += colWidths[i];
    });
    yPos += 9;

    // Data rows
    const attColors = {
      present: [46, 125, 50],
      late:    [230, 81, 0],
      absent:  [198, 40, 40],
    };

    payload.rows.forEach((row, ri) => {
      // Page break
      if (yPos + rowH > H - 15) {
        doc.addPage();
        yPos = 15;
        // Reprint header
        doc.setFillColor(...accentRGB);
        doc.rect(startX, yPos, tableW, 9, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        cx = startX;
        colNames.forEach((name, i) => {
          doc.text(name, cx + 2, yPos + 6);
          cx += colWidths[i];
        });
        yPos += 9;
      }

      // Row background
      if (ri % 2 === 0) {
        doc.setFillColor(250, 247, 242);
        doc.rect(startX, yPos, tableW, rowH, 'F');
      } else {
        doc.setFillColor(255, 255, 255);
        doc.rect(startX, yPos, tableW, rowH, 'F');
      }

      // Row divider
      doc.setDrawColor(224, 212, 192);
      doc.setLineWidth(0.1);
      doc.line(startX, yPos + rowH, startX + tableW, yPos + rowH);

      doc.setTextColor(44, 36, 22);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);

      cx = startX;
      if (payload.type === 'lesson') {
        doc.text(String(row.studentName || '').substring(0, 30), cx + 2, yPos + 5.5);
        cx += colWidths[0];

        const att = row.attendance || 'present';
        const attRgb = attColors[att] || [0, 0, 0];
        doc.setTextColor(...attRgb);
        doc.setFont('helvetica', 'bold');
        doc.text(att.charAt(0).toUpperCase() + att.slice(1), cx + 2, yPos + 5.5);
        cx += colWidths[1];

        doc.setTextColor(44, 36, 22);
        doc.setFont('helvetica', 'normal');
        (row.grades || []).forEach((g, gi) => {
          doc.text(String(g || '—'), cx + colWidths[gi + 2] / 2, yPos + 5.5, { align: 'center' });
          cx += colWidths[gi + 2];
        });
      } else {
        const cells = [row.name, row.phone, row.email, row.parentName, `${row.attendanceRate ?? 100}%`];
        cells.forEach((val, ci) => {
          if (ci === 4) {
            const rate = row.attendanceRate ?? 100;
            const rateRgb = rate >= 80 ? [46, 125, 50] : rate >= 50 ? [230, 81, 0] : [198, 40, 40];
            doc.setTextColor(...rateRgb);
            doc.setFont('helvetica', 'bold');
            doc.text(String(val || '—'), cx + colWidths[ci] / 2, yPos + 5.5, { align: 'center' });
            doc.setTextColor(44, 36, 22);
            doc.setFont('helvetica', 'normal');
          } else {
            doc.text(String(val || '—').substring(0, 22), cx + 2, yPos + 5.5);
          }
          cx += colWidths[ci];
        });
      }
      yPos += rowH;
    });

    // ── Footer on each page ────────────────────────────────────────────────
    const pageCount = doc.internal.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setFillColor(245, 241, 235);
      doc.rect(0, H - 10, W, 10, 'F');
      doc.setTextColor(160, 128, 96);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.text(`GradeJournal Professional  ·  ${payload.institutionName}`, 10, H - 4);
      doc.text(`Page ${p} of ${pageCount}`, W - 10, H - 4, { align: 'right' });
    }

    const filename = payload.type === 'lesson'
      ? `GradeJournal-${payload.className}-${payload.lessonName}-${payload.lessonDate}.pdf`
      : `GradeJournal-${payload.className}-Roster.pdf`;
    doc.save(filename.replace(/[^a-zA-Z0-9\-_.]/g, '_'));
    toast('✅ PDF downloaded!');

  } catch (err) {
    console.error('PDF export error:', err);
    toast('❌ PDF export failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📄 Export as PDF'; }
  }
}

function hslToRgbArr(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)      { r = c; g = x; }
  else if (h < 120){ r = x; g = c; }
  else if (h < 180){ g = c; b = x; }
  else if (h < 240){ g = x; b = c; }
  else if (h < 300){ r = x; b = c; }
  else             { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function formatDateDisplay(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return dateStr; }
}

// EXCEL EXPORT — server-side ExcelJS
async function exportExcel() {
  if (!currentExportContext) return;
  closeOv('ov-export');
  toast('📊 Generating Excel…');

  try {
    const payload = buildExportPayload(currentExportContext);

    const response = await fetch(`${API_BASE}/api/export/excel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || 'Export failed');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filename = payload.type === 'lesson'
      ? `GradeJournal-${payload.className}-${payload.lessonName}.xlsx`
      : `GradeJournal-${payload.className}-Roster.xlsx`;
    a.download = filename.replace(/[^a-zA-Z0-9\-_.]/g, '_');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    toast('✅ Excel downloaded!');

  } catch (err) {
    console.error('Excel export error:', err);
    toast('❌ Excel export failed: ' + err.message);
  }
}

// ============================================
// BACKUP & RESTORE
// ============================================
function backupData() {
  try {
    const dataStr = JSON.stringify(DB, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `gradejournal-backup-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toast('✅ Backup downloaded!');
  } catch (error) {
    console.error('Backup failed:', error);
    toast('❌ Backup failed');
  }
}

function restoreFromFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        
        confirm_('Restore Backup', 'This will replace all current data. Continue?', async () => {
          DB = backup;
          rebuildIndex();
          
          // Ensure exportSettings exists
          if (!DB.exportSettings) {
            DB.exportSettings = { color: { h: 30, s: 60, l: 50, a: 100 } };
          }
          
          await saveDB('home', true);
          
          if (supabase && DB.user?.mode === 'supabase') {
            await syncWithCloud();
          }
          
          toast('✅ Data restored!');
          renderClassrooms();
        });
      } catch (error) {
        console.error('Restore failed:', error);
        toast('❌ Invalid backup file');
      }
    };
    reader.readAsText(file);
  };
  
  input.click();
}

// ============================================
// EXPORT SETTINGS
// ============================================
let colorPickerState = { h: 30, s: 60, l: 50, a: 100 };
let colorPickerListenersAttached = false;

function openExportSettings() {
  closeOv('ov-export');

  if (!DB.exportSettings) {
    DB.exportSettings = { color: { h: 30, s: 60, l: 50, a: 100 } };
  }
  
  const previewZone = safeGetElement('file-preview-zone');
  const logoPreview = safeGetElement('export-logo-preview');
  const fileName = safeGetElement('file-preview-name');
  const fileSize = safeGetElement('file-preview-size');
  
  if (DB.exportSettings.logo && logoPreview && fileName && fileSize && previewZone) {
    logoPreview.src = DB.exportSettings.logo;
    fileName.textContent = DB.exportSettings.logoName || 'company-logo.png';
    fileSize.textContent = DB.exportSettings.logoSize || '120 KB';
    previewZone.classList.add('show');
  } else if (previewZone) {
    previewZone.classList.remove('show');
    if (logoPreview) logoPreview.src = '';
  }
  
  const col = DB.exportSettings.color || { h: 30, s: 60, l: 50, a: 100 };
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
  
  const handlers = {
    dragenter: (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over'); },
    dragover: (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag-over'); },
    dragleave: (e) => { e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag-over'); },
    drop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
      const files = e.dataTransfer.files;
      if (files.length) {
        handleLogoFile(files[0]);
      }
    }
  };
  
  // Remove old listeners and add new ones
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.removeEventListener(eventName, handlers[eventName]);
    dropZone.addEventListener(eventName, handlers[eventName], false);
  });
}

function onExportLogoFileChange(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  handleLogoFile(file);
}

function handleLogoFile(file) {
  if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) {
    toast('❌ Please upload PNG or JPEG only');
    return;
  }
  
  if (file.size > 2 * 1024 * 1024) { // Reduced to 2MB max
    toast('❌ File too large. Max 2MB');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = (event) => {
    // Compress image if needed
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Max dimensions
      const maxWidth = 400;
      const maxHeight = 400;
      let width = img.width;
      let height = img.height;
      
      if (width > height) {
        if (width > maxWidth) {
          height *= maxWidth / width;
          width = maxWidth;
        }
      } else {
        if (height > maxHeight) {
          width *= maxHeight / height;
          height = maxHeight;
        }
      }
      
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(img, 0, 0, width, height);
      
      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.8);
      
      const logoPreview = safeGetElement('export-logo-preview');
      const fileName = safeGetElement('file-preview-name');
      const fileSize = safeGetElement('file-preview-size');
      const previewZone = safeGetElement('file-preview-zone');
      
      if (logoPreview) logoPreview.src = compressedDataUrl;
      if (fileName) fileName.textContent = file.name;
      if (fileSize) fileSize.textContent = formatFileSize(file.size);
      if (previewZone) previewZone.classList.add('show');
      
      DB.exportSettings.logo = compressedDataUrl;
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
  
  if (DB.exportSettings) {
    delete DB.exportSettings.logo;
    delete DB.exportSettings.logoName;
    delete DB.exportSettings.logoSize;
    saveDB('home');
  }
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

function toggleColorPicker() {
  const dropdown = safeGetElement('color-picker-dropdown');
  if (!dropdown) return;
  
  const isVisible = dropdown.classList.contains('show');
  
  if (isVisible) {
    dropdown.classList.remove('show');
    // Clean up global listeners
    document.onmousemove = null;
    document.onmouseup = null;
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
    let x = e.clientX - rect.left;
    let y = e.clientY - rect.top;
    
    x = Math.max(0, Math.min(x, rect.width));
    y = Math.max(0, Math.min(y, rect.height));
    
    colorPickerState.s = Math.round((x / rect.width) * 100);
    colorPickerState.l = Math.round(100 - (y / rect.height) * 100);
    
    const satSlider = safeGetElement('sat-slider');
    const lightSlider = safeGetElement('light-slider');
    
    if (satSlider) satSlider.value = colorPickerState.s;
    if (lightSlider) lightSlider.value = colorPickerState.l;
    
    updateColorDisplay();
  };
  
  const onMouseMove = (e) => {
    if (isDragging) updateFromMouse(e);
  };
  
  const onMouseUp = () => {
    isDragging = false;
    document.onmousemove = null;
    document.onmouseup = null;
  };
  
  gradientBar.onmousedown = (e) => {
    isDragging = true;
    updateFromMouse(e);
    document.onmousemove = onMouseMove;
    document.onmouseup = onMouseUp;
  };
  
  // Store cleanup function
  window.__colorPickerCleanup = () => {
    gradientBar.onmousedown = null;
    document.onmousemove = null;
    document.onmouseup = null;
  };
}

function updateGradientBackground() {
  const gradientBar = safeGetElement('color-gradient-bar');
  if (!gradientBar) return;
  
  const h = colorPickerState.h;
  
  gradientBar.style.background = `
    linear-gradient(to top, #000, transparent),
    linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))
  `;
}

function updateColorDisplay() {
  const { h, s, l, a } = colorPickerState;
  
  const swatch = safeGetElement('color-swatch');
  const colorValue = safeGetElement('color-value');
  const hueValue = safeGetElement('hue-value');
  const satValue = safeGetElement('sat-value');
  const lightValue = safeGetElement('light-value');
  const opacityValue = safeGetElement('opacity-value');
  
  if (swatch) {
    swatch.style.background = `hsla(${h}, ${s}%, ${l}%, ${a / 100})`;
  }
  
  if (colorValue) {
    colorValue.textContent = `hsl(${h}°, ${s}%, ${l}%) • ${a}% opacity`;
  }
  
  if (hueValue) hueValue.textContent = h + '°';
  if (satValue) satValue.textContent = s + '%';
  if (lightValue) lightValue.textContent = l + '%';
  if (opacityValue) opacityValue.textContent = a + '%';
  
  const dropdown = safeGetElement('color-picker-dropdown');
  if (dropdown && dropdown.classList.contains('show')) {
    updateGradientBackground();
    const cursor = safeGetElement('color-cursor');
    if (cursor) {
      cursor.style.left = s + '%';
      cursor.style.top = (100 - l) + '%';
    }
  }
  
  const opacitySlider = safeGetElement('opacity-slider');
  if (opacitySlider) {
    opacitySlider.style.background = `linear-gradient(to right, transparent, hsl(${h}, ${s}%, ${l}%))`;
  }
}

function saveExportSettings() {
  if (!DB.exportSettings) DB.exportSettings = {};
  
  DB.exportSettings.color = { ...colorPickerState };
  
  saveDB('home', true);
  closeOv('ov-export-settings');
  
  const dropdown = safeGetElement('color-picker-dropdown');
  if (dropdown) dropdown.classList.remove('show');
  
  // Clean up color picker listeners
  if (window.__colorPickerCleanup) {
    window.__colorPickerCleanup();
    window.__colorPickerCleanup = null;
  }
  
  toast('✓ Export settings saved');
  
  if (safeGetElement('s-auth')?.classList.contains('active')) {
    loadAuthLogo();
  }
}

function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  
  if (h >= 0 && h < 60) { r = c; g = x; b = 0; }
  else if (h >= 60 && h < 120) { r = x; g = c; b = 0; }
  else if (h >= 120 && h < 180) { r = 0; g = c; b = x; }
  else if (h >= 180 && h < 240) { r = 0; g = x; b = c; }
  else if (h >= 240 && h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255)
  ];
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
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        target = inputs[idx + 1];
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        target = inputs[idx - 1];
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // Move down one row (same column)
        target = inputs[idx + cols] || inputs[idx - cols];
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        target = inputs[idx + cols];
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        target = inputs[idx - cols];
      }
      if (target) { target.focus(); target.select(); }
    });
  });
}

// ============================================
// SEARCH/FILTER
// ============================================
let _studentFilter = '';
let _lessonFilter = '';

function filterStudents(val) {
  _studentFilter = val.toLowerCase();
  renderStudents();
}

function filterLessons(val) {
  _lessonFilter = val.toLowerCase();
  renderLessons();
}

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
  // Remove any existing undo toast
  document.querySelectorAll('.toast-undo').forEach(t => t.remove());
  clearTimeout(_undoTimeout);

  const t = document.createElement('div');
  t.className = 'toast toast-undo';
  t.innerHTML = `${description} <button class="toast-undo-btn" onclick="doUndo()">Undo</button>`;
  document.body.appendChild(t);
  _undoTimeout = setTimeout(() => {
    t.remove();
    _undoStack.pop();
  }, 5000);
}

function doUndo() {
  clearTimeout(_undoTimeout);
  document.querySelectorAll('.toast-undo').forEach(t => t.remove());
  const entry = _undoStack.pop();
  if (!entry) return;
  entry.restoreFn(entry.snapshot);
  rebuildIndex();
  saveDB('home', true);
  renderClassrooms();
  if (safeGetElement('s-classroom')?.classList.contains('active')) {
    renderStudents(); renderLessons(); renderAnalytics();
  }
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
  banner.innerHTML = `⚠️ Working offline — changes saved locally and will sync when reconnected.`;
  document.body.prepend(banner);
}

function hideOfflineBanner() {
  safeGetElement('offline-banner')?.remove();
}

// ============================================
// WELCOME CARD (first-time home screen helper)
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
  const students = classroom.students.filter(s =>
    lesson.studentIds ? lesson.studentIds.includes(s.id) : true
  );
  if (!students.length) return 'empty';

  const cols = lesson.mode === 'ielts'
    ? classroom.columns.filter(c => c.ielts && c.lessonId === lesson.id && c.name !== 'Overall Band')
    : classroom.columns.filter(c => !c.ielts);

  if (!cols.length) return 'att-only';

  const total = students.length * cols.length;
  const filled = students.reduce((sum, s) =>
    sum + cols.filter(col => (lesson.data || {})[`col_${col.id}_${s.id}`]?.trim()).length, 0);

  if (filled === 0) return 'att-only';
  if (filled < total) return 'partial';
  return 'complete';
}

// ============================================
// GLOBAL KEYBOARD SHORTCUTS
// ============================================
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Don't fire when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    // Don't fire when a modal is open
    if (document.querySelector('.ov.open')) return;

    const s = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) return;

    if (s === 'n') {
      // New — context-aware
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

// ============================================
// INITIALIZE: override renderClassrooms to add welcome card + search
// ============================================

// ── UNDO-aware wrappers for destructive actions ─────────────────────────────
const _origDeleteClassConfirm = window.deleteClassConfirm;
function deleteClassConfirm(id) {
  const c = getC(id);
  if (!c) return;
  
  const snapshot = JSON.parse(JSON.stringify(DB.classrooms));
  confirm_(`Delete "${c.name}"?`, 'All students, lessons, and grades will be permanently deleted.', () => {
    DB.classrooms = DB.classrooms.filter(c => c.id !== id);
    rebuildIndex();
    saveDB('home', true);
    renderClassrooms();
    pushUndo(`Deleted "${c.name}"`,
      () => snapshot,
      (snap) => { DB.classrooms = snap; }
    );
  });
}

// ============================================
// INIT ENHANCEMENTS
// ============================================

// ============================================
// ANALYTICS WITH CHART
// ============================================
async function showConflictDialog(conflict) {
  return new Promise((resolve) => {
    const modal = safeGetElement('ov-conflict');
    const content = safeGetElement('conflict-content');
    
    if (!modal || !content) {
      resolve('local');
      return;
    }
    
    content.innerHTML = `
      <div style="margin-bottom:20px">
        <h3>Conflict Detected: ${conflict.type}</h3>
        <p>This item was modified on both devices.</p>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
        <div style="background:var(--cream-2);padding:16px;border-radius:12px">
          <div style="font-weight:700;margin-bottom:8px">Local Version</div>
          <pre style="font-size:11px;overflow:auto">${JSON.stringify(conflict.local, null, 2).substring(0, 200)}</pre>
        </div>
        <div style="background:var(--cream-2);padding:16px;border-radius:12px">
          <div style="font-weight:700;margin-bottom:8px">Cloud Version</div>
          <pre style="font-size:11px;overflow:auto">${JSON.stringify(conflict.cloud, null, 2).substring(0, 200)}</pre>
        </div>
      </div>
    `;
    
    const handleChoice = (choice) => {
      closeOv('ov-conflict');
      resolve(choice);
    };
    
    const keepLocalBtn = safeGetElement('conflict-keep-local');
    const keepCloudBtn = safeGetElement('conflict-keep-cloud');
    const mergeBtn = safeGetElement('conflict-merge');
    
    if (keepLocalBtn) keepLocalBtn.onclick = () => handleChoice('local');
    if (keepCloudBtn) keepCloudBtn.onclick = () => handleChoice('cloud');
    if (mergeBtn) mergeBtn.onclick = () => handleChoice('merge');
    
    openOv('ov-conflict');
  });
}

async function showMergeEditor(conflict) {
  // Simple merge - could be enhanced with diff editor
  toast('Auto-merging...');
  return 'local'; // Default to local for now
}

// ============================================
// DEMO REQUEST FUNCTION
// ============================================
function openDemoRequest() {
  openOv('ov-demo');
}

// ============================================
// UTILITY FUNCTIONS
// ============================================
function openOv(id) { 
  const el = safeGetElement(id);
  if (el) el.classList.add('open');
}
function closeOv(id) { 
  const el = safeGetElement(id);
  if (el) el.classList.remove('open');
}
function v(id) { 
  const el = safeGetElement(id);
  return el ? el.value.trim() : ''; 
}
function sv(id, val) { 
  const el = safeGetElement(id);
  if (el) el.value = val; 
}

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); 
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
// Alias for backward compatibility
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
  // Setup color picker listeners
  const hueSlider = safeGetElement('hue-slider');
  const satSlider = safeGetElement('sat-slider');
  const lightSlider = safeGetElement('light-slider');
  const opacitySlider = safeGetElement('opacity-slider');
  
  if (hueSlider) {
    hueSlider.addEventListener('input', (e) => {
      colorPickerState.h = parseInt(e.target.value);
      updateColorDisplay();
    });
  }
  
  if (satSlider) {
    satSlider.addEventListener('input', (e) => {
      colorPickerState.s = parseInt(e.target.value);
      updateColorDisplay();
    });
  }
  
  if (lightSlider) {
    lightSlider.addEventListener('input', (e) => {
      colorPickerState.l = parseInt(e.target.value);
      updateColorDisplay();
    });
  }
  
  if (opacitySlider) {
    opacitySlider.addEventListener('input', (e) => {
      colorPickerState.a = parseInt(e.target.value);
      updateColorDisplay();
    });
  }
  
  setupDragAndDrop();

  // Keyboard shortcuts
  initKeyboardShortcuts();

  // Offline/online detection with banner
  window.addEventListener('online', () => {
    hideOfflineBanner();
    showToast('📶 Back online — syncing…');
    if (DB.user?.mode === 'supabase') syncWithCloud();
  });
  window.addEventListener('offline', () => {
    showOfflineBanner();
    DB.syncStatus = 'offline';
    updateSyncUI();
  });
  
  // Global escape key handler
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.ov.open').forEach(el => el.classList.remove('open'));
      safeGetElement('sheet-ov')?.classList.remove('open');
      safeGetElement('color-picker-dropdown')?.classList.remove('show');
      
      if (window.__colorPickerCleanup) {
        window.__colorPickerCleanup();
        window.__colorPickerCleanup = null;
      }
    }
  });
  
  // Handle page unload - save any pending changes
  window.addEventListener('beforeunload', () => {
    if (DB.pendingChanges && DB.pendingChanges.length > 0) {
      saveToLocalStorage();
    }
  });
});

// Splash screen and initial load
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

// Clean up on page unload
window.addEventListener('unload', () => {
  if (splashTimeout) clearTimeout(splashTimeout);
  stopAutoSync();
  if (abortController) abortController.abort();
  if (window.__colorPickerCleanup) window.__colorPickerCleanup();
});
