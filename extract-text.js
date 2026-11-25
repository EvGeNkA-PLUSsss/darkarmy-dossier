// extract-text.js — [NEW] единый экстрактор текста из файлов
'use strict';
const fs = require('fs');
const path = require('path');

const TEXT_EXT   = ['md','markdown','txt','js','json','css','html','xml','csv','log',
                    'yml','yaml','ts','sh','env','ini','conf'];
const DOCX_EXT   = ['docx'];
const XLSX_EXT   = ['xlsx','xls','ods'];
const PPTX_EXT   = ['pptx','ppt','odp','odt'];
const PDF_EXT    = ['pdf'];
const IMG_EXT    = ['png','jpg','jpeg','gif','webp','bmp'];   // svg идёт как текст

const EXTRACTABLE_EXT = new Set([
  ...TEXT_EXT, ...DOCX_EXT, ...XLSX_EXT, ...PPTX_EXT, ...PDF_EXT,
]);

let mammoth = null, XLSX = null, pdfParse = null, officeparser = null;
try { mammoth = require('mammoth'); } catch {}
try { XLSX = require('xlsx'); } catch {}
try {
  // pdf-parse при обычном require может тянуть тестовый файл — берём субмодуль
  pdfParse = require('pdf-parse/lib/pdf-parse.js');
} catch {
  try { pdfParse = require('pdf-parse'); } catch {}
}
try { officeparser = require('officeparser'); } catch {}

const isTextExt       = e => TEXT_EXT.includes(e);
const isDocxExt       = e => DOCX_EXT.includes(e);
const isXlsxExt       = e => XLSX_EXT.includes(e);
const isPptxExt       = e => PPTX_EXT.includes(e);
const isPdfExt        = e => PDF_EXT.includes(e);
const isImgExt        = e => IMG_EXT.includes(e);
const isExtractable   = e => EXTRACTABLE_EXT.has(e);

async function extractText(absPath, ext) {
  ext = (ext || path.extname(absPath).slice(1) || '').toLowerCase();

  if (isTextExt(ext)) {
    return fs.readFileSync(absPath, 'utf8');
  }

  if (isDocxExt(ext)) {
    if (!mammoth) throw new Error('mammoth не установлен');
    const res = await mammoth.extractRawText({ buffer: fs.readFileSync(absPath) });
    return res.value || '';
  }

  if (isXlsxExt(ext)) {
    if (!XLSX) throw new Error('xlsx не установлен');
    const wb = XLSX.readFile(absPath);
    const parts = [];
    for (const name of wb.SheetNames) {
      parts.push('### Лист: ' + name);
      parts.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]));
    }
    return parts.join('\n\n');
  }

  if (isPdfExt(ext) || isPptxExt(ext)) {
    if (!officeparser) throw new Error('officeparser не установлен');
    return await officeparser.parseOfficeAsync(absPath);
  }

  throw new Error('Unsupported extension: ' + ext);
}

module.exports = {
  TEXT_EXT, DOCX_EXT, XLSX_EXT, PPTX_EXT, PDF_EXT, IMG_EXT, EXTRACTABLE_EXT,
  isTextExt, isDocxExt, isXlsxExt, isPptxExt, isPdfExt, isImgExt, isExtractable,
  extractText,
};