"use strict";

// ── Phone normalization (same logic as db.js) ─────────────────────────────────

function normPhone(raw) {
  var digits = String(raw || "").trim().replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("972") && digits.length >= 11) return "0" + digits.slice(3);
  if (digits.length === 9 && !digits.startsWith("0")) return "0" + digits;
  return digits;
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseRow(line) {
  var fields = [], current = "", inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(text) {
  // Strip UTF-8 BOM
  text = text.replace(/^﻿/, "");
  var lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (!lines.length) return { rows: [], errors: ["הקובץ ריק"] };

  var header = parseRow(lines[0]);
  var idx = {};
  header.forEach(function (col, i) { idx[col.trim()] = i; });

  // Validate expected columns
  var required = ["שם פרטי", "שם משפחה"];
  var missing = required.filter(function (c) { return idx[c] === undefined; });
  if (missing.length) {
    return { rows: [], errors: ["עמודות חסרות: " + missing.join(", ")] };
  }

  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim()) continue;
    var f = parseRow(line);

    var firstName  = (f[idx["שם פרטי"]]    || "").trim();
    var lastName   = (f[idx["שם משפחה"]]   || "").trim();
    var fullName   = [firstName, lastName].filter(Boolean).join(" ");

    var street   = (f[idx["רחוב"]]        || "").trim();
    var houseNum = (f[idx["מספר בית"]]    || "").trim();
    var apt      = (f[idx["דירה"]]        || "").trim();
    var entrance = (f[idx["כניסה"]]       || "").trim();
    var addrParts = [street, houseNum,
      apt      ? "דירה " + apt      : "",
      entrance ? "כניסה " + entrance : ""].filter(Boolean);

    rows.push({
      externalId:   (f[idx["מספר סידורי"]]  || "").trim(),
      alfonSerial:  (f[idx["מ.ס."]]          || "").trim(),
      firstName:    firstName,
      lastName:     lastName,
      fullName:     fullName,
      idNumber:     (f[idx["תעודת זהות"]]   || "").trim(),
      titleBefore:  (f[idx["תואר לפני"]]    || "").trim(),
      titleAfter:   (f[idx["תואר לאחר"]]    || "").trim(),
      fatherName:   (f[idx["שם אב"]]         || "").trim(),
      alfonCategory:(f[idx["קטגוריה"]]       || "").trim(),
      city:         (f[idx["ישוב"]]          || "").trim(),
      address:      addrParts.join(" "),
      neighborhood: (f[idx["שכונה"]]         || "").trim(),
      phone1:       (f[idx["פלאפון א"]]      || "").trim(),
      phone2:       (f[idx["פלאפון ב"]]      || "").trim(),
      phone3:       (f[idx["טלפון ביתי"]]    || "").trim(),
      phone4:       (f[idx["פלאפון נוסף"]]   || "").trim(),
      lineNum:      i + 1,
    });
  }
  return { rows: rows, errors: [] };
}

// ── Preview builder ───────────────────────────────────────────────────────────

function buildPreview(csvRows, existingDonors) {
  // Build lookup maps
  var byExternalId = {};
  var byPhone = {};

  existingDonors.forEach(function (d) {
    if (d.externalId) byExternalId[String(d.externalId)] = d;
    [d.phone, d.phone2, d.phone3, d.phone4].forEach(function (p) {
      var n = normPhone(p);
      if (n) byPhone[n] = d;
    });
  });

  var results = [];
  var seenExtId = {};
  var seenPhones = {};

  csvRows.forEach(function (row) {
    if (!row.fullName.trim()) {
      results.push(Object.assign({}, row, { action: "skip", reason: "no_name" }));
      return;
    }

    var rowPhones = [row.phone1, row.phone2, row.phone3, row.phone4]
      .map(normPhone).filter(Boolean);

    // Dedup within file
    var dupPhone = rowPhones.some(function (p) { return seenPhones[p]; });
    var dupExt   = row.externalId && seenExtId[row.externalId];
    if (dupPhone || dupExt) {
      results.push(Object.assign({}, row, { action: "skip", reason: "duplicate_in_file" }));
      return;
    }

    rowPhones.forEach(function (p) { seenPhones[p] = true; });
    if (row.externalId) seenExtId[row.externalId] = true;

    // Match to existing
    var match = null;
    if (row.externalId) match = byExternalId[row.externalId] || null;
    if (!match) {
      for (var pi = 0; pi < rowPhones.length; pi++) {
        if (byPhone[rowPhones[pi]]) { match = byPhone[rowPhones[pi]]; break; }
      }
    }

    if (match) {
      var existingPhones = {};
      [match.phone, match.phone2, match.phone3, match.phone4]
        .map(normPhone).filter(Boolean)
        .forEach(function (p) { existingPhones[p] = true; });

      var newPhones    = rowPhones.filter(function (p) { return !existingPhones[p]; });
      var primaryPhoneChg = !!(rowPhones[0] && rowPhones[0] !== normPhone(match.phone));
      var nameChanged  = !!(row.fullName    && row.fullName    !== match.fullName);
      var firstNameChg = !!(row.firstName   && row.firstName   !== match.firstName);
      var lastNameChg  = !!(row.lastName    && row.lastName    !== match.lastName);
      var idNumChanged = !!(row.idNumber    && row.idNumber    !== match.idNumber);
      var titleBefChg  = !!(row.titleBefore && row.titleBefore !== match.titleBefore);
      var titleAftChg  = !!(row.titleAfter  && row.titleAfter  !== match.titleAfter);
      var fatherChg    = !!(row.fatherName  && row.fatherName  !== match.fatherName);
      var categoryChg  = !!(row.alfonCategory && row.alfonCategory !== match.alfonCategory);
      var effectiveCity = (row.city && !/^\d+$/.test(row.city)) ? row.city : "";
      var cityChanged   = !!(effectiveCity && effectiveCity !== match.city);
      var addrChanged   = !!(row.address    && row.address    !== match.address);
      var neighChanged  = !!(row.neighborhood && row.neighborhood !== match.neighborhood);
      var extIdAdded    = !!(row.externalId && !match.externalId);

      var hasChanges = primaryPhoneChg || nameChanged || firstNameChg || lastNameChg ||
                       idNumChanged || titleBefChg || titleAftChg || fatherChg || categoryChg ||
                       cityChanged || addrChanged || neighChanged ||
                       newPhones.length > 0 || extIdAdded;

      results.push(Object.assign({}, row, {
        action:       hasChanges ? "update" : "unchanged",
        existingId:   match.id,
        existingName: match.fullName,
        existingPhone:match.phone,
        changes:      { primaryPhoneChg, nameChanged, firstNameChg, lastNameChg,
                        idNumChanged, titleBefChg, titleAftChg, fatherChg, categoryChg,
                        cityChanged, addrChanged, neighChanged, newPhones, extIdAdded },
      }));
    } else {
      if (rowPhones.length === 0) {
        results.push(Object.assign({}, row, { action: "skip", reason: "no_phone" }));
      } else {
        results.push(Object.assign({}, row, { action: "create" }));
      }
    }
  });

  return results;
}

// ── Apply sync ────────────────────────────────────────────────────────────────

function applySync(preview, existingDonors, upsertDonorFn) {
  var donorById = {};
  existingDonors.forEach(function (d) { donorById[d.id] = d; });

  var maxId = existingDonors.reduce(function (mx, d) { return Math.max(mx, d.id || 0); }, 0);
  var nextId = maxId + 1;

  var added = 0, updated = 0, skipped = 0, failed = 0;
  var newDonors = existingDonors.slice(); // clone array

  preview.forEach(function (row) {
    if (row.action === "skip" || row.action === "unchanged") { skipped++; return; }

    try {
      if (row.action === "create") {
        var rowPhones = [row.phone1, row.phone2, row.phone3, row.phone4]
          .filter(function (p) { return normPhone(p); });
        var primaryPhone = rowPhones[0];

        var newDonor = {
          id:           nextId++,
          externalId:   row.externalId    || "",
          alfonSerial:  row.alfonSerial   || "",
          idNumber:     row.idNumber      || "",
          titleBefore:  row.titleBefore   || "",
          firstName:    row.firstName     || "",
          lastName:     row.lastName      || "",
          titleAfter:   row.titleAfter    || "",
          fatherName:   row.fatherName    || "",
          alfonCategory:row.alfonCategory || "",
          fullName:     row.fullName,
          phone:        primaryPhone,
          phone2:       rowPhones[1] || "",
          phone3:       rowPhones[2] || "",
          phone4:       rowPhones[3] || "",
          city:         row.city        || "",
          address:      row.address     || "",
          neighborhood: row.neighborhood|| "",
          status:       "פעיל",
          notes:       "",
          donations:   [],
          debts:       [],
          tasks:       [],
          reminders:   [],
          callbacks:   [],
          tags:        [],
          internalStaffNote:   "",
          publicPhoneNote:     "",
          phoneMessageSettings:{ sendMessages: false, messageType: "basic" },
          createdAt:   new Date().toISOString(),
          updatedAt:   new Date().toISOString(),
        };
        newDonors.push(newDonor);
        try { upsertDonorFn(primaryPhone, row.fullName); } catch (_) {}
        added++;

      } else if (row.action === "update") {
        var donor = donorById[row.existingId];
        if (!donor) { failed++; return; }

        // Update all personal fields from alfon (never touch financial/notes/history)
        if (row.externalId)    donor.externalId    = row.externalId;
        if (row.alfonSerial)   donor.alfonSerial   = row.alfonSerial;
        if (row.idNumber)      donor.idNumber      = row.idNumber;
        if (row.titleBefore)   donor.titleBefore   = row.titleBefore;
        if (row.firstName)     donor.firstName     = row.firstName;
        if (row.lastName)      donor.lastName      = row.lastName;
        if (row.titleAfter)    donor.titleAfter    = row.titleAfter;
        if (row.fatherName)    donor.fatherName    = row.fatherName;
        if (row.alfonCategory) donor.alfonCategory = row.alfonCategory;
        if (row.fullName)      donor.fullName      = row.fullName;
        if (row.city && !/^\d+$/.test(row.city)) donor.city = row.city;
        if (row.address)       donor.address       = row.address;
        if (row.neighborhood)  donor.neighborhood  = row.neighborhood;

        // Phone update: alfon primary phone becomes system primary
        var alfonPrimary = normPhone(row.phone1);
        if (alfonPrimary) {
          var currentPrimary = normPhone(donor.phone);
          if (alfonPrimary !== currentPrimary) {
            // Preserve old primary in extra slot if not already stored
            var storedNorms = [donor.phone2, donor.phone3, donor.phone4].map(normPhone).filter(Boolean);
            if (currentPrimary && storedNorms.indexOf(currentPrimary) === -1) {
              if (!normPhone(donor.phone2))      donor.phone2 = donor.phone;
              else if (!normPhone(donor.phone3)) donor.phone3 = donor.phone;
              else if (!normPhone(donor.phone4)) donor.phone4 = donor.phone;
            }
            donor.phone = row.phone1; // alfon primary → system primary (IVR)
          }
        }

        // Merge remaining alfon phones into extra slots (never remove existing)
        var existingPhoneSet = {};
        [donor.phone, donor.phone2, donor.phone3, donor.phone4]
          .map(normPhone).filter(Boolean)
          .forEach(function (p) { existingPhoneSet[p] = true; });

        [row.phone2, row.phone3, row.phone4].forEach(function (phone) {
          var n = normPhone(phone);
          if (!n || existingPhoneSet[n]) return;
          existingPhoneSet[n] = true;
          if (!normPhone(donor.phone2))      donor.phone2 = phone;
          else if (!normPhone(donor.phone3)) donor.phone3 = phone;
          else if (!normPhone(donor.phone4)) donor.phone4 = phone;
        });

        donor.updatedAt = new Date().toISOString();
        try { upsertDonorFn(donor.phone, donor.fullName); } catch (_) {}
        updated++;
      }
    } catch (e) {
      failed++;
    }
  });

  return { added: added, updated: updated, skipped: skipped, failed: failed, donors: newDonors };
}

module.exports = { parseCsv, buildPreview, applySync, normPhone };
