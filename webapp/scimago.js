/**
 * scimago.js
 * -----------------------------------------------------------------------
 * Loads / parses / looks up SCImago Journal Rank data.
 *
 * Source CSV format (as published by scimagojr.com "Download data"):
 *   - semicolon (;) delimited
 *   - row 1 = header
 *   - decimals use comma as separator (e.g. "1,605" === 1.605)
 *   - some fields are quoted and may contain embedded ";" (e.g. ISSN, Categories)
 *
 * Columns used (1-indexed, per spec):
 *   2  Sourceid            -> used to build the SCImago journal-search URL
 *   3  Title                -> journal name, used as the lookup key
 *   6  Publisher            -> kept for display
 *   9  SJR                  -> score (comma decimal converted to dot)
 *   10 SJR Best Quartile    -> Q1-Q4 badge
 *   25 Categories           -> subject areas / per-category quartiles
 *
 * Everything here is self-contained: no network calls, no external deps.
 * Parsed data is cached in IndexedDB so a ~30k row CSV only needs to be
 * parsed once (until the user uploads a new file).
 * -----------------------------------------------------------------------
 */

(function (global) {
  'use strict';

  var DB_NAME = 'pubmed_tool_db';
  var DB_VERSION = 1;
  var STORE_NAME = 'scimago';
  var RECORD_KEY = 'current'; // single record holding the currently-active dataset

  // -----------------------------------------------------------------
  // Low-level delimited-line parser (handles quoted fields containing
  // the delimiter itself, RFC4180-style but with ';' as the separator).
  // -----------------------------------------------------------------
  function parseDelimitedLine(line, delimiter) {
    delimiter = delimiter || ';';
    var result = [];
    var cur = '';
    var inQuotes = false;

    for (var i = 0; i < line.length; i++) {
      var c = line[i];

      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === delimiter) {
          result.push(cur);
          cur = '';
        } else {
          cur += c;
        }
      }
    }
    result.push(cur);
    return result;
  }

  // Convert a SCImago-style numeric string ("1,605") to a JS float.
  function parseScimagoNumber(raw) {
    if (raw === undefined || raw === null) return null;
    var trimmed = String(raw).trim();
    if (trimmed === '') return null;
    var normalized = trimmed.replace(/\./g, '').replace(',', '.');
    // Note: SCImago also uses '.' as a thousands separator in some export
    // locales for large integers (e.g. Total Docs). For SJR (a small
    // decimal like "1,605") there is no thousands separator, so the
    // replace(/\./g,'') above is a no-op for the fields we care about.
    var n = parseFloat(normalized);
    return isNaN(n) ? null : n;
  }

  /**
   * Parse a full SCImago CSV text blob into a Map keyed by
   * lowercase-trimmed journal title.
   *
   * @param {string} text  Raw CSV file contents.
   * @returns {Map<string, object>}
   */
  function parseScimagoCSV(text) {
    var map = new Map();
    if (!text) return map;

    // Normalize line endings, split, drop empty trailing lines.
    var lines = text.split(/\r\n|\r|\n/).filter(function (l) {
      return l.trim().length > 0;
    });
    if (lines.length < 2) return map;

    // lines[0] is the header row - skip it (columns are fixed/known).
    for (var i = 1; i < lines.length; i++) {
      var cols = parseDelimitedLine(lines[i], ';');
      if (cols.length < 10) continue; // malformed / too short to be useful

      var sourceId = (cols[1] || '').trim();      // col 2
      var title = (cols[2] || '').trim();          // col 3
      var publisher = (cols[5] || '').trim();       // col 6
      var sjrRaw = cols[8];                          // col 9
      var quartileRaw = (cols[9] || '').trim();     // col 10
      var categories = (cols[24] || '').trim();     // col 25

      if (!title) continue;

      var key = title.toLowerCase().trim();
      map.set(key, {
        sourceId: sourceId,
        title: title,
        publisher: publisher,
        sjr: parseScimagoNumber(sjrRaw),
        quartile: quartileRaw || null,
        categories: categories
      });
    }

    return map;
  }

  /**
   * Look up a journal name (as returned by PubMed esummary, e.g.
   * fulljournalname) against the parsed SCImago Map.
   * Phase 1-2: exact lowercase match only (no fuzzy matching yet).
   *
   * @param {Map} map
   * @param {string} journalName
   * @returns {object|null}
   */
  function lookupJournal(map, journalName) {
    if (!map || !journalName) return null;
    var key = String(journalName).toLowerCase().trim();
    return map.get(key) || null;
  }

  function sourceUrlFor(sourceId) {
    if (!sourceId) return null;
    return 'https://www.scimagojr.com/journalsearch.php?q=' + encodeURIComponent(sourceId) + '&tip=sid';
  }

  // -----------------------------------------------------------------
  // IndexedDB persistence
  // -----------------------------------------------------------------
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in global)) {
        reject(new Error('IndexedDB not supported in this browser'));
        return;
      }
      var req = global.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (evt) {
        var db = evt.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /**
   * Persist a parsed Map + metadata (filename / year / uploadedAt) to
   * IndexedDB so it survives page reloads without re-parsing the CSV.
   */
  function saveScimagoData(map, meta) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var entries = Array.from(map.entries());
        var record = {
          id: RECORD_KEY,
          entries: entries,
          meta: meta || {},
          savedAt: Date.now()
        };
        var req = store.put(record);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
        tx.oncomplete = function () { db.close(); };
      });
    });
  }

  /**
   * Load the previously-saved dataset from IndexedDB, if any.
   * @returns {Promise<{map: Map, meta: object}|null>}
   */
  function loadScimagoData() {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        var req = store.get(RECORD_KEY);
        req.onsuccess = function () {
          var record = req.result;
          if (!record) {
            resolve(null);
            return;
          }
          var map = new Map(record.entries);
          resolve({ map: map, meta: record.meta || {} });
        };
        req.onerror = function () { reject(req.error); };
        tx.oncomplete = function () { db.close(); };
      });
    }).catch(function () {
      // IndexedDB unavailable or errored - treat as "no data cached".
      return null;
    });
  }

  // Best-effort extraction of a year (e.g. "2025") from an uploaded
  // filename like "scimagojr 2025.csv", used purely for the "currently
  // using SCImago <year>" display text in Settings.
  function guessYearFromFilename(filename) {
    if (!filename) return null;
    var m = String(filename).match(/(19|20)\d{2}/);
    return m ? m[0] : null;
  }

  global.Scimago = {
    parseDelimitedLine: parseDelimitedLine,
    parseScimagoNumber: parseScimagoNumber,
    parseScimagoCSV: parseScimagoCSV,
    lookupJournal: lookupJournal,
    sourceUrlFor: sourceUrlFor,
    saveScimagoData: saveScimagoData,
    loadScimagoData: loadScimagoData,
    guessYearFromFilename: guessYearFromFilename
  };

})(typeof window !== 'undefined' ? window : this);
