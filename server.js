'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const ExcelJS = require('exceljs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// 🔥🔥🔥 ABSOLUTE TOP - BEFORE ANYTHING ELSE 🔥🔥🔥
app.use((req, res, next) => {
  // This is the MOST PERMISSIVE CSP possible - allows everything
  res.setHeader('Content-Security-Policy', 
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
    "script-src * 'unsafe-inline' 'unsafe-eval'; " +
    "style-src * 'unsafe-inline'; " +
    "img-src * data: blob:; " +
    "connect-src *; " +
    "font-src * data:; " +
    "frame-src *; " +
    "media-src *; " +
    "object-src *;"
  );
  
  // Also add these headers to be sure
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  next();
});

// NO helmet AT ALL - completely removed

app.use(compression());

// ─── Rate limiting ───────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: '*',
  credentials: true,
}));

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ─── Dev logging ─────────────────────────────────────────────────────────────
if (!isProduction) {
  app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
    next();
  });
}

// ─── Static files ─────────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');
const staticDir = fs.existsSync(publicDir) ? publicDir : __dirname;
app.use(express.static(staticDir, { maxAge: isProduction ? '1d' : 0, etag: true }));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '6.1.0',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// ─── Validation helpers ───────────────────────────────────────────────────────
function validateLessonData(data) {
  const errors = [];
  if (!data.className || typeof data.className !== 'string') errors.push('Missing className');
  if (!data.lessonName || typeof data.lessonName !== 'string') errors.push('Missing lessonName');
  if (!data.lessonDate || typeof data.lessonDate !== 'string') errors.push('Missing lessonDate');
  if (!Array.isArray(data.columns)) errors.push('columns must be an array');
  if (!Array.isArray(data.rows)) errors.push('rows must be an array');
  if (data.rows && data.rows.length > 500) errors.push('Too many rows (max 500)');
  return errors;
}

function validateClassData(data) {
  const errors = [];
  if (!data.className || typeof data.className !== 'string') errors.push('Missing className');
  if (!Array.isArray(data.rows)) errors.push('rows must be an array');
  if (data.rows && data.rows.length > 500) errors.push('Too many rows (max 500)');
  return errors;
}

// ─── Excel export helpers ───────────────────────────────────────────────────
function styleHeaderRow(row, accentArgb) {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFF' }, name: 'Calibri', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accentArgb } };
    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: false };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FFFFFF' } },
      bottom: { style: 'thin', color: { argb: 'FFFFFF' } },
    };
  });
  row.height = 32;
}

function styleDataCell(cell, even) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: even ? 'FFF8F4EE' : 'FFFFFFFF' } };
  cell.alignment = { vertical: 'middle' };
  cell.font = { name: 'Calibri', size: 10 };
  cell.border = {
    bottom: { style: 'hair', color: { argb: 'FFE0D4C0' } },
  };
}

function hslToArgb(h, s, l) {
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
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `FF${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// ─── Excel export endpoint ────────────────────────────────────────────────────
app.post('/api/export/excel', async (req, res) => {
  try {
    const data = req.body;
    if (!data.type || !['lesson', 'class'].includes(data.type)) {
      return res.status(400).json({ error: 'Invalid export type' });
    }

    let accentArgb = 'FFC17F3A';
    if (data.accentColor) {
      const m = data.accentColor.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
      if (m) accentArgb = hslToArgb(+m[1], +m[2], +m[3]);
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = 'GradeJournal';
    wb.created = new Date();
    wb.modified = new Date();

    if (data.type === 'lesson') {
      const errors = validateLessonData(data);
      if (errors.length) return res.status(400).json({ error: errors.join(', ') });

      const ws = wb.addWorksheet('Lesson Results', {
        pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true },
        views: [{ state: 'frozen', xSplit: 1, ySplit: 5 }],
      });

      const colCount = data.columns.length + 2;
      
      ws.mergeCells(1, 1, 1, colCount);
      const titleCell = ws.getCell('A1');
      titleCell.value = `${data.className}  ·  ${data.lessonName}`;
      titleCell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FF2C2416' } };
      titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8F0' } };
      ws.getRow(1).height = 36;

      ws.mergeCells(2, 1, 2, colCount);
      ws.getCell('A2').value = `Date: ${data.lessonDate}  ·  Generated ${new Date().toLocaleDateString()}`;
      ws.getCell('A2').font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FFA08060' } };
      ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8F0' } };
      ws.getRow(2).height = 20;

      ws.mergeCells(3, 1, 3, colCount);
      ws.getRow(3).height = 8;

      const present = data.rows.filter(r => r.attendance === 'present').length;
      const late = data.rows.filter(r => r.attendance === 'late').length;
      const absent = data.rows.filter(r => r.attendance === 'absent').length;
      const total = data.rows.length;
      const rate = total > 0 ? Math.round(((present + late) / total) * 100) : 100;

      ws.mergeCells(4, 1, 4, colCount);
      ws.getCell('A4').value = `📊 Attendance: ${rate}%  |  ✅ Present: ${present}  ·  ⏰ Late: ${late}  ·  ❌ Absent: ${absent}`;
      ws.getCell('A4').font = { name: 'Calibri', size: 10, color: { argb: 'FF5C4A2A' } };
      ws.getCell('A4').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF0DC' } };
      ws.getRow(4).height = 22;

      const headerRow = ws.getRow(5);
      headerRow.getCell(1).value = 'Student';
      headerRow.getCell(2).value = 'Attendance';
      data.columns.forEach((col, i) => { headerRow.getCell(i + 3).value = col; });
      styleHeaderRow(headerRow, accentArgb);

      data.rows.forEach((row, idx) => {
        const exRow = ws.getRow(idx + 6);
        exRow.getCell(1).value = row.studentName || '';
        const att = (row.attendance || 'present');
        exRow.getCell(2).value = att.charAt(0).toUpperCase() + att.slice(1);

        const attColors = { present: 'FFE8F5E9', late: 'FFFFF3E0', absent: 'FFFFEBEE' };
        const attFontColors = { present: 'FF2E7D32', late: 'FFE65100', absent: 'FFC62828' };
        exRow.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: attColors[att] || 'FFFFFFFF' } };
        exRow.getCell(2).font = { name: 'Calibri', size: 10, bold: true, color: { argb: attFontColors[att] || 'FF000000' } };

        (row.grades || []).forEach((grade, ci) => {
          exRow.getCell(ci + 3).value = grade || '';
        });

        for (let c = 1; c <= colCount; c++) {
          const cell = exRow.getCell(c);
          if (c !== 2) styleDataCell(cell, idx % 2 === 1);
          else {
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFE0D4C0' } } };
          }
        }
        exRow.height = 26;
      });

      ws.getColumn(1).width = 28;
      ws.getColumn(2).width = 14;
      for (let c = 3; c <= colCount; c++) ws.getColumn(c).width = 14;

    } else {
      const errors = validateClassData(data);
      if (errors.length) return res.status(400).json({ error: errors.join(', ') });

      const ws = wb.addWorksheet('Class Roster', {
        pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true },
        views: [{ state: 'frozen', xSplit: 0, ySplit: 4 }],
      });

      ws.mergeCells('A1:F1');
      ws.getCell('A1').value = `${data.className}  ·  Class Roster`;
      ws.getCell('A1').font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FF2C2416' } };
      ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8F0' } };
      ws.getRow(1).height = 36;

      ws.mergeCells('A2:F2');
      ws.getCell('A2').value = `Generated ${new Date().toLocaleDateString()}  ·  ${data.rows.length} students`;
      ws.getCell('A2').font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FFA08060' } };
      ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF8F0' } };
      ws.getRow(2).height = 20;

      ws.mergeCells('A3:F3');
      ws.getRow(3).height = 8;

      const headerRow = ws.getRow(4);
      ['Student', 'Phone', 'Email', 'Parent / Guardian', 'Parent Phone', 'Attendance Rate'].forEach((h, i) => {
        headerRow.getCell(i + 1).value = h;
      });
      styleHeaderRow(headerRow, accentArgb);

      data.rows.forEach((row, idx) => {
        const exRow = ws.getRow(idx + 5);
        exRow.getCell(1).value = row.name || '';
        exRow.getCell(2).value = row.phone || '';
        exRow.getCell(3).value = row.email || '';
        exRow.getCell(4).value = row.parentName || '';
        exRow.getCell(5).value = row.parentPhone || '';

        const rate = row.attendanceRate ?? 100;
        exRow.getCell(6).value = `${rate}%`;

        const rateArgb = rate >= 80 ? 'FF2E7D32' : rate >= 50 ? 'FFE65100' : 'FFC62828';
        exRow.getCell(6).font = { name: 'Calibri', size: 10, bold: true, color: { argb: rateArgb } };

        for (let c = 1; c <= 6; c++) {
          const cell = exRow.getCell(c);
          if (c !== 6) styleDataCell(cell, idx % 2 === 1);
          else {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: idx % 2 === 1 ? 'FFF8F4EE' : 'FFFFFFFF' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = { bottom: { style: 'hair', color: { argb: 'FFE0D4C0' } } };
          }
        }
        exRow.height = 26;
      });

      ws.columns = [
        { width: 28 }, { width: 18 }, { width: 28 },
        { width: 24 }, { width: 18 }, { width: 16 },
      ];
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="GradeJournal-${data.type}-${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ error: isProduction ? 'Export failed' : err.message });
  }
});

// Catch-all route
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  res.status(500).json({
    error: isProduction ? 'Internal server error' : err.message,
  });
});

const server = app.listen(PORT, () => {
  console.log(`✅ GradeJournal v6.1 running on port ${PORT}`);
  console.log(`📊 Excel exports: ExcelJS`);
  console.log(`📄 PDF exports: client-side jsPDF`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  if (!isProduction) console.log(`   → http://localhost:${PORT}`);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
process.on('SIGINT', () => { server.close(() => process.exit(0)); });
